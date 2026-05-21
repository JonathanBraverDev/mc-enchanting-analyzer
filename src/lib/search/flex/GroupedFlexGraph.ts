import { ENGINE_LIMITS } from '#constants/engine.js';
import type { SearchPool, SearchPoolEntry } from '#lib/search/registry/RegistryKernel.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import type { PackedEnchant } from '#types/index.js';
import { PRECISION, ProbUtils } from '#utils/index.js';
import type {
    FlexAlternative,
    FlexEdge,
    FlexExpansion,
    FlexGraph,
    FlexNode,
    FlexNodeId,
    FlexProgramId
} from '#lib/search/flex/FlexTypes.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';

interface PendingGroupedEdge {
    readonly childExclusionMask: bigint;
    readonly alternatives: FlexAlternative[];
    weight: number;
}

/**
 * Registry-derived grouped graph for Flex.
 *
 * This is the first PlexNode-capable Flex graph. It groups only alternatives
 * that lead to the same future exclusion state, so grouped choices have the same
 * downstream eligibility behavior as their concrete singleton alternatives.
 */
export class GroupedFlexGraph implements FlexGraph {
    public readonly pool: SearchPool;

    private readonly exclusionMasks: bigint[] = [];
    private readonly currentLevels: number[] = [];
    private readonly counts: number[] = [];
    private readonly programIds: FlexProgramId[] = [];
    private readonly nodeIndex = new Map<bigint, FlexNodeId>();
    private readonly expansionCache: Array<FlexExpansion | undefined> = [];

    public constructor(
        private readonly kernel: RegistryKernel,
        pool: SearchPool,
        private readonly programs: FlexProgramStore
    ) {
        this.pool = pool;
    }

    public get size(): number {
        return this.counts.length;
    }

    public getRootNode(initialLevel: number): FlexNode {
        return this.createNode(this.getOrCreateNodeId(
            0n,
            initialLevel,
            0,
            this.programs.empty
        ));
    }

    public getExpansion(nodeId: FlexNodeId): FlexExpansion {
        this.assertNode(nodeId);
        const cached = this.expansionCache[nodeId as number];
        if (cached) return cached;

        const expansion = this.counts[nodeId as number] === 0
            ? this.buildRootExpansion(nodeId)
            : this.buildSearchExpansion(nodeId);
        this.expansionCache[nodeId as number] = expansion;
        return expansion;
    }

    public getNode(nodeId: FlexNodeId): FlexNode {
        this.assertNode(nodeId);
        return this.createNode(nodeId);
    }

    public getProgramId(nodeId: FlexNodeId): FlexProgramId {
        this.assertNode(nodeId);
        return this.programIds[nodeId as number]!;
    }

    public getNodeCount(nodeId: FlexNodeId): number {
        this.assertNode(nodeId);
        return this.counts[nodeId as number]!;
    }

    public getNodeCurrentLevel(nodeId: FlexNodeId): number {
        this.assertNode(nodeId);
        return this.currentLevels[nodeId as number]!;
    }

    public getNodeExclusionMask(nodeId: FlexNodeId): bigint {
        this.assertNode(nodeId);
        return this.exclusionMasks[nodeId as number]!;
    }

    private buildRootExpansion(nodeId: FlexNodeId): FlexExpansion {
        const nodeIndex = nodeId as number;
        const currentLevel = this.currentLevels[nodeIndex]!;
        const edges = this.buildGroupedEdges(this.pool.entries, nodeIndex, currentLevel, 1);

        return this.createExpansion(
            nodeId,
            PRECISION,
            this.pool.totalWeight,
            edges,
            null
        );
    }

    private buildSearchExpansion(nodeId: FlexNodeId): FlexExpansion {
        const nodeIndex = nodeId as number;
        const exclusionMask = this.exclusionMasks[nodeIndex]!;
        const currentLevel = this.currentLevels[nodeIndex]!;
        const count = this.counts[nodeIndex]!;
        const terminalReason = this.getTerminalReason(count);
        const probContinue = terminalReason === 'single-book'
            ? 0n
            : (ProbUtils.PROB_CONTINUE_TABLE[currentLevel] ?? PRECISION);

        if (terminalReason === 'max-enchants' || terminalReason === 'single-book') {
            return this.createExpansion(
                nodeId,
                probContinue,
                0,
                [],
                terminalReason === 'max-enchants' ? 'overflow' : null
            );
        }

        const eligibleEntries = this.pool.entries.filter(entry => (exclusionMask & entry.idBit) === 0n);
        const childLevel = Math.floor(currentLevel / 2);
        const childCount = count + 1;
        const edges = this.buildGroupedEdges(eligibleEntries, nodeIndex, childLevel, childCount);
        const totalWeight = eligibleEntries.reduce((sum, entry) => sum + entry.weight, 0);

        return this.createExpansion(nodeId, probContinue, totalWeight, edges, null);
    }

    private buildGroupedEdges(
        entries: readonly SearchPoolEntry[],
        parentNodeIndex: number,
        childLevel: number,
        childCount: number
    ): readonly FlexEdge[] {
        const groups: PendingGroupedEdge[] = [];
        const parentExclusionMask = this.exclusionMasks[parentNodeIndex]!;

        for (const entry of entries) {
            const childExclusionMask = parentExclusionMask | entry.blocksBitset;
            let group = groups.find(candidate => candidate.childExclusionMask === childExclusionMask);
            if (!group) {
                group = {
                    childExclusionMask,
                    alternatives: [],
                    weight: 0
                };
                groups.push(group);
            }

            this.addAlternative(group, entry.packedEnchant, entry.weight);
            group.weight += entry.weight;
        }

        return Object.freeze(groups
            .map(group => this.createGroupedEdge(group, parentNodeIndex, childLevel, childCount))
            .sort(compareFlexEdges));
    }

    private addAlternative(group: PendingGroupedEdge, packedEnchant: PackedEnchant, weight: number): void {
        const existing = group.alternatives.find(alternative => alternative.packedEnchant === packedEnchant);
        if (existing) {
            const index = group.alternatives.indexOf(existing);
            group.alternatives[index] = Object.freeze({
                packedEnchant,
                weight: existing.weight + weight
            });
            return;
        }

        group.alternatives.push(Object.freeze({ packedEnchant, weight }));
    }

    private createGroupedEdge(
        group: PendingGroupedEdge,
        parentNodeIndex: number,
        childLevel: number,
        childCount: number
    ): FlexEdge {
        const alternatives = Object.freeze([...group.alternatives].sort(compareAlternatives));
        const parentProgramId = this.programIds[parentNodeIndex]!;
        const childProgramId = alternatives.length === 1
            ? this.programs.appendFixed(parentProgramId, alternatives[0]!.packedEnchant)
            : this.programs.appendChoice(parentProgramId, alternatives);
        const childId = this.getOrCreateNodeId(
            group.childExclusionMask,
            childLevel,
            childCount,
            childProgramId
        );

        return Object.freeze({
            weight: group.weight,
            childId
        });
    }

    private createExpansion(
        nodeId: FlexNodeId,
        probContinue: bigint,
        totalWeight: number,
        edges: readonly FlexEdge[],
        terminalReason: FlexExpansion['terminalReason']
    ): FlexExpansion {
        return Object.freeze({
            node: this.createNode(nodeId),
            probContinue,
            totalWeight,
            edges: Object.freeze([...edges]),
            terminalReason
        });
    }

    private getOrCreateNodeId(
        exclusionMask: bigint,
        currentLevel: number,
        count: number,
        programId: FlexProgramId
    ): FlexNodeId {
        const key = this.createNodeKey(exclusionMask, currentLevel, count);
        const existing = this.nodeIndex.get(key);
        if (existing !== undefined) return existing;

        const id = this.counts.length as FlexNodeId;
        this.exclusionMasks.push(exclusionMask);
        this.currentLevels.push(currentLevel);
        this.counts.push(count);
        this.programIds.push(programId);
        this.expansionCache.push(undefined);
        this.nodeIndex.set(key, id);
        return id;
    }

    private createNode(nodeId: FlexNodeId): FlexNode {
        return this.programs.createNode(nodeId, this.getProgramId(nodeId));
    }

    private createNodeKey(exclusionMask: bigint, currentLevel: number, count: number): bigint {
        return (exclusionMask << 16n) | (BigInt(currentLevel) << 8n) | BigInt(count);
    }

    private getTerminalReason(count: number): 'max-enchants' | 'single-book' | null {
        if (this.kernel.item === 'book' && !this.kernel.multiEnchantBooks && count >= 1) {
            return 'single-book';
        }
        if (count >= ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM) {
            return 'max-enchants';
        }
        return null;
    }

    private assertNode(nodeId: FlexNodeId): void {
        const index = nodeId as number;
        if (!Number.isInteger(index) || index < 0 || index >= this.counts.length) {
            throw new Error(`Unknown GroupedFlex graph node ${String(nodeId)}.`);
        }
    }
}

function compareAlternatives(left: FlexAlternative, right: FlexAlternative): number {
    return Number(left.packedEnchant) - Number(right.packedEnchant);
}

function compareFlexEdges(left: FlexEdge, right: FlexEdge): number {
    if (left.weight !== right.weight) return right.weight - left.weight;
    return Number(left.childId) - Number(right.childId);
}
