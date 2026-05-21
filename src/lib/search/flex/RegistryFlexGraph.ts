import { ENGINE_LIMITS } from '#constants/engine.js';
import type { SearchPool, SearchPoolEntry } from '#lib/search/registry/RegistryKernel.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import type { PackedCombo } from '#types/index.js';
import { ComboUtils, PRECISION, ProbUtils } from '#utils/index.js';
import type {
    FlexEdge,
    FlexExpansion,
    FlexGraph,
    FlexNode,
    FlexNodeId,
    FlexProgramId
} from '#lib/search/flex/FlexTypes.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';

/**
 * Registry-derived SolidNode graph for Flex.
 *
 * Unlike SolidFlexGraph, this does not wrap SearchGraph. It directly derives the
 * V7-equivalent singleton path graph from RegistryKernel pool entries.
 */
export class RegistryFlexGraph implements FlexGraph {
    public readonly pool: SearchPool;

    private readonly selectedMasks: bigint[] = [];
    private readonly currentLevels: number[] = [];
    private readonly combos: PackedCombo[] = [];
    private readonly programIds: FlexProgramId[] = [];
    private readonly counts: number[] = [];
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
            0 as PackedCombo,
            this.programs.empty,
            0
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

    public getNodeCombo(nodeId: FlexNodeId): PackedCombo {
        this.assertNode(nodeId);
        return this.combos[nodeId as number]!;
    }

    public getNodeCount(nodeId: FlexNodeId): number {
        this.assertNode(nodeId);
        return this.counts[nodeId as number]!;
    }

    private buildRootExpansion(nodeId: FlexNodeId): FlexExpansion {
        const nodeIndex = nodeId as number;
        const currentLevel = this.currentLevels[nodeIndex]!;
        const edges = this.pool.entries.map(entry => this.createEdge(
            entry,
            nodeIndex,
            currentLevel,
            1
        ));

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
        const selectedMask = this.selectedMasks[nodeIndex]!;
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

        const childLevel = Math.floor(currentLevel / 2);
        const childCount = count + 1;
        const edges: FlexEdge[] = [];
        let totalWeight = 0;

        for (const entry of this.pool.entries) {
            if ((selectedMask & entry.idBit) !== 0n) continue;
            if ((selectedMask & entry.conflictBitset) !== 0n) continue;

            totalWeight += entry.weight;
            edges.push(this.createEdge(entry, nodeIndex, childLevel, childCount));
        }

        return this.createExpansion(nodeId, probContinue, totalWeight, edges, null);
    }

    private createEdge(
        entry: SearchPoolEntry,
        parentNodeIndex: number,
        childLevel: number,
        childCount: number
    ): FlexEdge {
        const childSelectedMask = this.selectedMasks[parentNodeIndex]! | entry.idBit;
        const childCombo = ComboUtils.packAppendIndex(
            this.combos[parentNodeIndex]!,
            entry.comboIndex,
            this.counts[parentNodeIndex]!
        );
        const childProgramId = this.programs.appendFixed(
            this.programIds[parentNodeIndex]!,
            entry.packedEnchant
        );
        const childId = this.getOrCreateNodeId(
            childSelectedMask,
            childLevel,
            childCombo,
            childProgramId,
            childCount
        );

        return Object.freeze({
            weight: entry.weight,
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
        selectedMask: bigint,
        currentLevel: number,
        combo: PackedCombo,
        programId: FlexProgramId,
        count: number
    ): FlexNodeId {
        const key = this.createNodeKey(selectedMask, currentLevel);
        const existing = this.nodeIndex.get(key);
        if (existing !== undefined) {
            this.assertExistingNodeMatches(existing, combo, count);
            return existing;
        }

        const id = this.counts.length as FlexNodeId;
        this.selectedMasks.push(selectedMask);
        this.currentLevels.push(currentLevel);
        this.combos.push(combo);
        this.programIds.push(programId);
        this.counts.push(count);
        this.expansionCache.push(undefined);
        this.nodeIndex.set(key, id);
        return id;
    }

    private createNode(nodeId: FlexNodeId): FlexNode {
        return this.programs.createNode(nodeId, this.getProgramId(nodeId));
    }

    private createNodeKey(selectedMask: bigint, currentLevel: number): bigint {
        return (selectedMask << 8n) | BigInt(currentLevel);
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

    private assertExistingNodeMatches(nodeId: FlexNodeId, combo: PackedCombo, count: number): void {
        const nodeIndex = nodeId as number;
        if (this.combos[nodeIndex] !== combo) {
            throw new Error(
                `RegistryFlexGraph node ${String(nodeId)} reached with combo ${String(combo)} after ${String(this.combos[nodeIndex])}.`
            );
        }
        if (this.counts[nodeIndex] !== count) {
            throw new Error(
                `RegistryFlexGraph node ${String(nodeId)} reached with count ${String(count)} after ${String(this.counts[nodeIndex])}.`
            );
        }
    }

    private assertNode(nodeId: FlexNodeId): void {
        const index = nodeId as number;
        if (!Number.isInteger(index) || index < 0 || index >= this.counts.length) {
            throw new Error(`Unknown RegistryFlex graph node ${String(nodeId)}.`);
        }
    }
}
