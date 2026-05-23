import { ENGINE_LIMITS, PACKING_CONSTANTS } from '#constants/engine.js';
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
    FlexProgramId,
    FlexStateIdentityMode
} from '#lib/search/flex/FlexTypes.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';
import { FLEX_HASH_CONSTANTS, FLEX_INDEX_LIMITS, FLEX_INDEX_SENTINELS } from '#lib/search/flex/FlexConstants.js';

interface PendingGroupedEdge {
    readonly childExclusionMask: bigint;
    readonly alternatives: FlexAlternative[];
    weight: number;
}

interface GroupedEdgeTemplate {
    readonly childExclusionMask: bigint;
    readonly alternatives: readonly FlexAlternative[];
    readonly weight: number;
}

interface GroupedExpansionTemplate {
    readonly totalWeight: number;
    readonly clueIncompatibleWeight: number;
    readonly groups: readonly GroupedEdgeTemplate[];
}

const FLEX_NODE_STATE_COUNT_STRIDE = ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM + 1;

class FlexNodeIndex {
    private exclusionMasks: bigint[] = [];
    private stateKeys: Int32Array;
    private programIds: Int32Array;
    private values: Int32Array;
    private used: Uint8Array;
    private mask: number;
    private resizeAt: number;
    private count = 0;

    public constructor(capacity: number = FLEX_INDEX_LIMITS.GRAPH_INITIAL_CAPACITY) {
        const size = FlexNodeIndex.nextPowerOfTwo(capacity);
        this.stateKeys = new Int32Array(size);
        this.programIds = new Int32Array(size);
        this.values = new Int32Array(size);
        this.values.fill(FLEX_INDEX_SENTINELS.MISSING_VALUE);
        this.used = new Uint8Array(size);
        this.mask = size - 1;
        this.resizeAt = Math.floor(size * FLEX_INDEX_LIMITS.GRAPH_MAX_LOAD_FACTOR);
    }

    public get(exclusionMask: bigint, stateKey: number, programId: FlexProgramId): FlexNodeId | undefined {
        let index = this.hash(exclusionMask, stateKey, programId) & this.mask;
        while (this.used[index] !== FLEX_INDEX_SENTINELS.EMPTY_SLOT) {
            if (this.stateKeys[index] === stateKey && this.programIds[index] === programId && this.exclusionMasks[index] === exclusionMask) {
                const value = this.values[index]!;
                return value === FLEX_INDEX_SENTINELS.MISSING_VALUE ? undefined : value as FlexNodeId;
            }
            index = (index + 1) & this.mask;
        }
        return undefined;
    }

    public set(exclusionMask: bigint, stateKey: number, programId: FlexProgramId, value: FlexNodeId): void {
        if (this.count >= this.resizeAt) this.grow();
        this.insert(exclusionMask, stateKey, programId, value);
    }

    private insert(exclusionMask: bigint, stateKey: number, programId: FlexProgramId, value: FlexNodeId): void {
        let index = this.hash(exclusionMask, stateKey, programId) & this.mask;
        while (this.used[index] !== FLEX_INDEX_SENTINELS.EMPTY_SLOT) {
            if (this.stateKeys[index] === stateKey && this.programIds[index] === programId && this.exclusionMasks[index] === exclusionMask) {
                this.values[index] = value;
                return;
            }
            index = (index + 1) & this.mask;
        }

        this.used[index] = FLEX_INDEX_SENTINELS.OCCUPIED_SLOT;
        this.exclusionMasks[index] = exclusionMask;
        this.stateKeys[index] = stateKey;
        this.programIds[index] = programId;
        this.values[index] = value;
        this.count++;
    }

    private grow(): void {
        const oldMasks = this.exclusionMasks;
        const oldStateKeys = this.stateKeys;
        const oldProgramIds = this.programIds;
        const oldValues = this.values;
        const oldUsed = this.used;
        const nextSize = oldStateKeys.length * FLEX_INDEX_LIMITS.GROWTH_FACTOR;

        this.exclusionMasks = [];
        this.stateKeys = new Int32Array(nextSize);
        this.programIds = new Int32Array(nextSize);
        this.values = new Int32Array(nextSize);
        this.values.fill(FLEX_INDEX_SENTINELS.MISSING_VALUE);
        this.used = new Uint8Array(nextSize);
        this.mask = nextSize - 1;
        this.resizeAt = Math.floor(nextSize * FLEX_INDEX_LIMITS.GRAPH_MAX_LOAD_FACTOR);
        this.count = 0;

        for (let i = 0; i < oldStateKeys.length; i++) {
            if (oldUsed[i] !== FLEX_INDEX_SENTINELS.EMPTY_SLOT) this.insert(oldMasks[i]!, oldStateKeys[i]!, oldProgramIds[i]! as FlexProgramId, oldValues[i]! as FlexNodeId);
        }
    }

    private hash(exclusionMask: bigint, stateKey: number, programId: FlexProgramId): number {
        const low = Number(exclusionMask & FLEX_HASH_CONSTANTS.U32_MASK) >>> 0;
        const high = Number((exclusionMask >> FLEX_HASH_CONSTANTS.U32_SHIFT) & FLEX_HASH_CONSTANTS.U32_MASK) >>> 0;
        let h = (low
            ^ Math.imul(high, FLEX_HASH_CONSTANTS.GOLDEN_RATIO_32)
            ^ Math.imul(stateKey, FLEX_HASH_CONSTANTS.STATE_KEY_MULTIPLIER)
            ^ Math.imul(programId, FLEX_HASH_CONSTANTS.PROGRAM_KEY_MULTIPLIER)) >>> 0;
        h ^= h >>> FLEX_HASH_CONSTANTS.AVALANCHE_SHIFT_1;
        h = Math.imul(h, FLEX_HASH_CONSTANTS.AVALANCHE_MULTIPLIER_1) >>> 0;
        h ^= h >>> FLEX_HASH_CONSTANTS.AVALANCHE_SHIFT_2;
        h = Math.imul(h, FLEX_HASH_CONSTANTS.AVALANCHE_MULTIPLIER_2) >>> 0;
        return (h ^ (h >>> FLEX_HASH_CONSTANTS.AVALANCHE_SHIFT_1)) >>> 0;
    }

    private static nextPowerOfTwo(value: number): number {
        let size = 1;
        while (size < value) size <<= 1;
        return size;
    }
}

export interface GroupedFlexGraphOptions {
    readonly stateIdentityMode?: FlexStateIdentityMode | undefined;
    readonly targetClueId?: number | undefined;
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
    private readonly nodeIndex = new FlexNodeIndex();
    private readonly expansionCache: Array<FlexExpansion | undefined> = [];
    private readonly groupedTemplateCache = new Map<bigint, GroupedExpansionTemplate>();
    private readonly stateIdentityMode: FlexStateIdentityMode;
    private readonly targetClueId: number | undefined;

    public constructor(
        private readonly kernel: RegistryKernel,
        pool: SearchPool,
        private readonly programs: FlexProgramStore,
        options: GroupedFlexGraphOptions = {}
    ) {
        this.pool = pool;
        this.stateIdentityMode = options.stateIdentityMode ?? 'reduced';
        this.targetClueId = options.targetClueId;
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
        const template = this.getGroupedExpansionTemplate(0n, this.programIds[nodeIndex]!);
        const edges = this.materializeGroupedEdges(template.groups, nodeIndex, currentLevel, 1);

        return this.createExpansion(
            nodeId,
            PRECISION,
            template.totalWeight,
            edges,
            template.clueIncompatibleWeight,
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
                0,
                terminalReason === 'max-enchants' ? 'overflow' : null
            );
        }

        const childLevel = Math.floor(currentLevel / 2);
        const childCount = count + 1;
        const template = this.getGroupedExpansionTemplate(exclusionMask, this.programIds[nodeIndex]!);
        const edges = this.materializeGroupedEdges(template.groups, nodeIndex, childLevel, childCount);

        return this.createExpansion(nodeId, probContinue, template.totalWeight, edges, template.clueIncompatibleWeight, null);
    }

    private getGroupedExpansionTemplate(
        parentExclusionMask: bigint,
        programId: FlexProgramId
    ): GroupedExpansionTemplate {
        const clueRestricted = this.targetClueId !== undefined && !this.programGuaranteesTargetClue(programId);
        const key = this.createGroupedTemplateKey(parentExclusionMask, clueRestricted);
        const cached = this.groupedTemplateCache.get(key);
        if (cached) return cached;

        const template = this.buildGroupedExpansionTemplate(parentExclusionMask, clueRestricted);
        this.groupedTemplateCache.set(key, template);
        return template;
    }

    private buildGroupedExpansionTemplate(
        parentExclusionMask: bigint,
        clueRestricted: boolean
    ): GroupedExpansionTemplate {
        const groups = new Map<bigint, PendingGroupedEdge>();
        let totalWeight = 0;
        let clueIncompatibleWeight = 0;

        for (const entry of this.pool.entries) {
            if ((parentExclusionMask & entry.idBit) !== 0n) continue;

            totalWeight += entry.weight;
            if (clueRestricted && !this.canSelectBeforeTargetClue(entry)) {
                clueIncompatibleWeight += entry.weight;
                continue;
            }

            const childExclusionMask = parentExclusionMask | entry.blocksBitset;
            let group = groups.get(childExclusionMask);
            if (!group) {
                group = {
                    childExclusionMask,
                    alternatives: [],
                    weight: 0
                };
                groups.set(childExclusionMask, group);
            }

            this.addAlternative(group, entry.packedEnchant, entry.weight);
            group.weight += entry.weight;
        }

        const groupedTemplates = [...groups.values()]
            .map(group => this.createGroupedEdgeTemplate(group));

        return Object.freeze({
            totalWeight,
            clueIncompatibleWeight,
            groups: Object.freeze(groupedTemplates)
        });
    }

    private materializeGroupedEdges(
        groups: readonly GroupedEdgeTemplate[],
        parentNodeIndex: number,
        childLevel: number,
        childCount: number
    ): readonly FlexEdge[] {
        return Object.freeze(groups
            .map(group => this.createGroupedEdge(group, parentNodeIndex, childLevel, childCount))
            .sort(compareFlexEdges));
    }

    private addAlternative(group: PendingGroupedEdge, packedEnchant: PackedEnchant, weight: number): void {
        const existing = group.alternatives.find(alternative => alternative.packedEnchant === packedEnchant);
        if (existing) {
            const index = group.alternatives.indexOf(existing);
            group.alternatives[index] = {
                packedEnchant,
                weight: existing.weight + weight
            };
            return;
        }

        group.alternatives.push({ packedEnchant, weight });
    }

    private createGroupedEdgeTemplate(group: PendingGroupedEdge): GroupedEdgeTemplate {
        return Object.freeze({
            childExclusionMask: group.childExclusionMask,
            alternatives: Object.freeze([...group.alternatives].sort(compareAlternatives)),
            weight: group.weight
        });
    }

    private createGroupedEdge(
        group: GroupedEdgeTemplate,
        parentNodeIndex: number,
        childLevel: number,
        childCount: number
    ): FlexEdge {
        if (this.stateIdentityMode === 'reduced') {
            const existing = this.getExistingReducedNodeId(group.childExclusionMask, childLevel, childCount);
            if (existing !== undefined) {
                return {
                    weight: group.weight,
                    childId: existing
                };
            }
        }

        const alternatives = group.alternatives;
        const parentProgramId = this.programIds[parentNodeIndex]!;
        const childProgramId = alternatives.length === 1
            ? this.programs.appendFixed(parentProgramId, alternatives[0]!.packedEnchant)
            : this.programs.appendCanonicalChoice(parentProgramId, alternatives);
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
        clueIncompatibleWeight: number,
        terminalReason: FlexExpansion['terminalReason']
    ): FlexExpansion {
        return Object.freeze({
            node: this.createNode(nodeId),
            probContinue,
            totalWeight,
            edges: Object.freeze([...edges]),
            clueIncompatibleWeight,
            terminalReason
        });
    }

    private createGroupedTemplateKey(parentExclusionMask: bigint, clueRestricted: boolean): bigint {
        return (parentExclusionMask << 1n) | (clueRestricted ? 1n : 0n);
    }

    private programGuaranteesTargetClue(programId: FlexProgramId): boolean {
        const targetClueId = this.targetClueId;
        if (targetClueId === undefined) return false;

        return this.programs.getProgram(programId).some(emission => {
            if (emission.kind === 'fixed') return emission.packedEnchant === targetClueId;
            return emission.alternatives.length > 0
                && emission.alternatives.every(alternative => alternative.packedEnchant === targetClueId);
        });
    }

    private canSelectBeforeTargetClue(entry: SearchPoolEntry): boolean {
        const targetClueId = this.targetClueId;
        if (targetClueId === undefined) return true;
        if (entry.packedEnchant === targetClueId) return true;

        const targetEnchantId = targetClueId >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        if (entry.enchantId === targetEnchantId) return false;

        const targetConflictBitset = this.kernel.registry.conflictBitsets[targetEnchantId] ?? 0n;
        return (targetConflictBitset & entry.idBit) === 0n;
    }

    private getOrCreateNodeId(
        exclusionMask: bigint,
        currentLevel: number,
        count: number,
        programId: FlexProgramId
    ): FlexNodeId {
        const stateKey = this.createNodeStateKey(currentLevel, count);
        const identityProgramId = this.getIdentityProgramId(programId);
        const existing = this.nodeIndex.get(exclusionMask, stateKey, identityProgramId);
        if (existing !== undefined) return existing;

        const id = this.counts.length as FlexNodeId;
        this.exclusionMasks.push(exclusionMask);
        this.currentLevels.push(currentLevel);
        this.counts.push(count);
        this.programIds.push(programId);
        this.expansionCache.push(undefined);
        this.nodeIndex.set(exclusionMask, stateKey, identityProgramId, id);
        return id;
    }

    private getExistingReducedNodeId(
        exclusionMask: bigint,
        currentLevel: number,
        count: number
    ): FlexNodeId | undefined {
        const stateKey = this.createNodeStateKey(currentLevel, count);
        return this.nodeIndex.get(exclusionMask, stateKey, 0 as FlexProgramId);
    }

    private createNode(nodeId: FlexNodeId): FlexNode {
        return this.programs.createNode(nodeId, this.getProgramId(nodeId));
    }

    private createNodeStateKey(
        currentLevel: number,
        count: number
    ): number {
        return (currentLevel * FLEX_NODE_STATE_COUNT_STRIDE) + count;
    }

    private getIdentityProgramId(programId: FlexProgramId): FlexProgramId {
        return this.stateIdentityMode === 'reduced' ? 0 as FlexProgramId : programId;
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
