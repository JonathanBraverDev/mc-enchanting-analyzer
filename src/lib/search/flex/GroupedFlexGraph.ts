import { ENGINE_LIMITS, PACKING_CONSTANTS } from '#constants/engine.js';
import type { SearchPool, SearchPoolEntry } from '#lib/search/registry/RegistryKernel.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import type { PackedEnchant } from '#types/index.js';
import { PRECISION, ProbUtils } from '#utils/index.js';
import type {
    FlexEdge,
    FlexEmission,
    FlexExpansion,
    FlexGraph,
    FlexGraphMemoryStats,
    FlexNode,
    FlexNodeId,
    FlexProgramId,
    FlexSearchExpansion,
    FlexSearchExpansionConsumer,
    FlexStateIdentityMode
} from '#lib/search/flex/FlexTypes.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';
import { FLEX_HASH_CONSTANTS, FLEX_INDEX_LIMITS, FLEX_INDEX_SENTINELS } from '#lib/search/flex/FlexConstants.js';

const FLEX_NODE_STATE_COUNT_STRIDE = ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM + 1;
const EMPTY_EDGE_WEIGHTS = new Uint32Array(0);
const EMPTY_EDGE_CHILD_IDS = new Int32Array(0);

interface GroupedExpansionShape {
    readonly totalWeight: number;
    readonly clueIncompatibleWeight: number;
    readonly groupCount: number;
    readonly childExclusionMasks: ArrayLike<bigint>;
    readonly edgeWeights: ArrayLike<number>;
    readonly emissions: readonly FlexEmission[];
}

interface MutableFlexSearchExpansion {
    nodeId: FlexNodeId;
    programId: FlexProgramId;
    nodeKind: FlexNode['kind'];
    count: number;
    probContinue: bigint;
    totalWeight: number;
    edgeCount: number;
    edgeWeights: ArrayLike<number>;
    edgeChildIds: ArrayLike<number>;
    clueIncompatibleWeight?: number | undefined;
    terminalReason: FlexExpansion['terminalReason'];
}

class FlexNodeIndex {
    private exclusionMasks: bigint[] = [];
    private stateKeys: Int32Array;
    private programIds: Int32Array;
    private values: Int32Array;
    private used: Uint8Array;
    private mask: number;
    private resizeAt: number;
    private count = 0;
    private _growCount = 0;

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

    public get growCount(): number {
        return this._growCount;
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
        this._growCount++;
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
    private readonly expansionCache: Array<FlexSearchExpansion | undefined> = [];
    private readonly debugExpansionCache: Array<FlexExpansion | undefined> = [];
    private readonly shapeCache = new Map<bigint, GroupedExpansionShape>();
    private readonly scratchGroupMasks: bigint[] = [];
    private readonly scratchGroupWeights: number[] = [];
    private readonly scratchGroupPackedEnchants: number[][] = [];
    private readonly scratchGroupAlternativeWeights: number[][] = [];
    private scratchEdgeWeights = EMPTY_EDGE_WEIGHTS;
    private scratchEdgeChildIds = EMPTY_EDGE_CHILD_IDS;
    private readonly scratchExpansion: MutableFlexSearchExpansion = {
        nodeId: 0 as FlexNodeId,
        programId: 0 as FlexProgramId,
        nodeKind: 'solid',
        count: 0,
        probContinue: 0n,
        totalWeight: 0,
        edgeCount: 0,
        edgeWeights: EMPTY_EDGE_WEIGHTS,
        edgeChildIds: EMPTY_EDGE_CHILD_IDS,
        clueIncompatibleWeight: 0,
        terminalReason: null
    };
    private readonly stateIdentityMode: FlexStateIdentityMode;
    private readonly targetClueId: number | undefined;
    private readonly targetClueEnchantId: number | undefined;
    private readonly targetClueConflictBitset: bigint;
    private searchExpansionCount = 0;
    private groupCount = 0;
    private groupingBuildCount = 0;
    private groupedEdgeCount = 0;
    private groupedAlternativeCount = 0;
    private debugExpansionCount = 0;

    public constructor(
        private readonly kernel: RegistryKernel,
        pool: SearchPool,
        private readonly programs: FlexProgramStore,
        options: GroupedFlexGraphOptions = {}
    ) {
        this.pool = pool;
        this.stateIdentityMode = options.stateIdentityMode ?? 'reduced';
        this.targetClueId = options.targetClueId;
        this.targetClueEnchantId = this.targetClueId === undefined
            ? undefined
            : this.targetClueId >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        this.targetClueConflictBitset = this.targetClueEnchantId === undefined
            ? 0n
            : this.kernel.registry.conflictBitsets[this.targetClueEnchantId] ?? 0n;
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
        const cached = this.debugExpansionCache[nodeId as number];
        if (cached) return cached;

        const expansion = this.createDebugExpansion(this.getSearchExpansion(nodeId));
        this.debugExpansionCache[nodeId as number] = expansion;
        this.debugExpansionCount++;
        return expansion;
    }

    public getSearchExpansion(nodeId: FlexNodeId): FlexSearchExpansion {
        this.assertNode(nodeId);
        const cached = this.expansionCache[nodeId as number];
        if (cached) return cached;

        const expansion = this.createOwnedSearchExpansion(nodeId);
        this.expansionCache[nodeId as number] = expansion;
        return expansion;
    }

    public withSearchExpansion<T>(nodeId: FlexNodeId, consumer: FlexSearchExpansionConsumer<T>): T {
        this.assertNode(nodeId);
        return consumer(this.createScratchSearchExpansion(nodeId));
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

    public getMemoryStats(): FlexGraphMemoryStats {
        return {
            nodeCount: this.size,
            searchExpansionCount: this.searchExpansionCount,
            debugExpansionCount: this.debugExpansionCount,
            groupingBuildCount: this.groupingBuildCount,
            groupedEdgeCount: this.groupedEdgeCount,
            groupedAlternativeCount: this.groupedAlternativeCount,
            nodeIndexGrowCount: this.nodeIndex.growCount
        };
    }

    private createOwnedSearchExpansion(nodeId: FlexNodeId): FlexSearchExpansion {
        return this.createSearchExpansionForNode(nodeId, false);
    }

    private createScratchSearchExpansion(nodeId: FlexNodeId): FlexSearchExpansion {
        return this.createSearchExpansionForNode(nodeId, true);
    }

    private createSearchExpansionForNode(nodeId: FlexNodeId, useScratch: boolean): FlexSearchExpansion {
        return this.counts[nodeId as number] === 0
            ? this.createRootSearchExpansion(nodeId, useScratch)
            : this.createNonRootSearchExpansion(nodeId, useScratch);
    }

    private createRootSearchExpansion(nodeId: FlexNodeId, useScratch: boolean): FlexSearchExpansion {
        const nodeIndex = nodeId as number;
        const currentLevel = this.currentLevels[nodeIndex]!;
        return this.createGroupedSearchExpansion(
            nodeId,
            PRECISION,
            0n,
            currentLevel,
            1,
            null,
            useScratch
        );
    }

    private createNonRootSearchExpansion(nodeId: FlexNodeId, useScratch: boolean): FlexSearchExpansion {
        const nodeIndex = nodeId as number;
        const exclusionMask = this.exclusionMasks[nodeIndex]!;
        const currentLevel = this.currentLevels[nodeIndex]!;
        const count = this.counts[nodeIndex]!;
        const terminalReason = this.getTerminalReason(count);
        const probContinue = terminalReason === 'single-book'
            ? 0n
            : (ProbUtils.PROB_CONTINUE_TABLE[currentLevel] ?? PRECISION);

        if (terminalReason === 'max-enchants' || terminalReason === 'single-book') {
            return this.createSearchExpansion(
                nodeId,
                probContinue,
                0,
                EMPTY_EDGE_WEIGHTS,
                EMPTY_EDGE_CHILD_IDS,
                0,
                0,
                terminalReason === 'max-enchants' ? 'overflow' : null,
                useScratch
            );
        }

        const childLevel = Math.floor(currentLevel / 2);
        const childCount = count + 1;
        return this.createGroupedSearchExpansion(nodeId, probContinue, exclusionMask, childLevel, childCount, null, useScratch);
    }

    private createGroupedSearchExpansion(
        nodeId: FlexNodeId,
        probContinue: bigint,
        parentExclusionMask: bigint,
        childLevel: number,
        childCount: number,
        terminalReason: FlexExpansion['terminalReason'],
        useScratch: boolean
    ): FlexSearchExpansion {
        const parentNodeIndex = nodeId as number;
        const parentProgramId = this.programIds[parentNodeIndex]!;
        const clueRestricted = this.targetClueId !== undefined && !this.programGuaranteesTargetClue(parentProgramId);
        const shapeKey = this.createGroupedExpansionShapeKey(parentExclusionMask, clueRestricted);
        const cached = this.shapeCache.get(shapeKey);
        if (cached) {
            return this.createGroupedSearchExpansionFromShape(
                nodeId,
                probContinue,
                childLevel,
                childCount,
                terminalReason,
                useScratch,
                parentNodeIndex,
                cached
            );
        }

        if (parentExclusionMask !== 0n) {
            return this.createDirectGroupedSearchExpansion(
                nodeId,
                probContinue,
                parentExclusionMask,
                childLevel,
                childCount,
                terminalReason,
                useScratch,
                parentNodeIndex,
                clueRestricted
            );
        }

        const shape = this.buildGroupedExpansionShape(parentExclusionMask, clueRestricted);
        this.shapeCache.set(shapeKey, shape);
        return this.createGroupedSearchExpansionFromShape(
            nodeId,
            probContinue,
            childLevel,
            childCount,
            terminalReason,
            useScratch,
            parentNodeIndex,
            shape
        );
    }

    private createGroupedSearchExpansionFromShape(
        nodeId: FlexNodeId,
        probContinue: bigint,
        childLevel: number,
        childCount: number,
        terminalReason: FlexExpansion['terminalReason'],
        useScratch: boolean,
        parentNodeIndex: number,
        shape: GroupedExpansionShape
    ): FlexSearchExpansion {
        const edgeWeights = useScratch
            ? this.getScratchEdgeWeights(shape.groupCount)
            : new Uint32Array(shape.groupCount);
        const edgeChildIds = useScratch
            ? this.getScratchEdgeChildIds(shape.groupCount)
            : new Int32Array(shape.groupCount);

        for (let groupIndex = 0; groupIndex < shape.groupCount; groupIndex++) {
            edgeWeights[groupIndex] = shape.edgeWeights[groupIndex]!;
            edgeChildIds[groupIndex] = this.createGroupedChildId(shape, groupIndex, parentNodeIndex, childLevel, childCount) as number;
        }
        sortEdgeArrays(edgeWeights, edgeChildIds, shape.groupCount);

        return this.createSearchExpansion(
            nodeId,
            probContinue,
            shape.totalWeight,
            edgeWeights,
            edgeChildIds,
            shape.groupCount,
            shape.clueIncompatibleWeight,
            terminalReason,
            useScratch
        );
    }

    private createDirectGroupedSearchExpansion(
        nodeId: FlexNodeId,
        probContinue: bigint,
        parentExclusionMask: bigint,
        childLevel: number,
        childCount: number,
        terminalReason: FlexExpansion['terminalReason'],
        useScratch: boolean,
        parentNodeIndex: number,
        clueRestricted: boolean
    ): FlexSearchExpansion {
        const { totalWeight, clueIncompatibleWeight } = this.buildScratchGroups(parentExclusionMask, clueRestricted);
        const edgeWeights = useScratch
            ? this.getScratchEdgeWeights(this.groupCount)
            : new Uint32Array(this.groupCount);
        const edgeChildIds = useScratch
            ? this.getScratchEdgeChildIds(this.groupCount)
            : new Int32Array(this.groupCount);

        for (let groupIndex = 0; groupIndex < this.groupCount; groupIndex++) {
            this.sortScratchAlternatives(groupIndex);
            edgeWeights[groupIndex] = this.scratchGroupWeights[groupIndex]!;
            edgeChildIds[groupIndex] = this.createGroupedChildIdFromScratch(groupIndex, parentNodeIndex, childLevel, childCount) as number;
        }
        sortEdgeArrays(edgeWeights, edgeChildIds, this.groupCount);

        return this.createSearchExpansion(
            nodeId,
            probContinue,
            totalWeight,
            edgeWeights,
            edgeChildIds,
            this.groupCount,
            clueIncompatibleWeight,
            terminalReason,
            useScratch
        );
    }

    private createGroupedExpansionShapeKey(parentExclusionMask: bigint, clueRestricted: boolean): bigint {
        return (parentExclusionMask << 1n) | (clueRestricted ? 1n : 0n);
    }

    private buildGroupedExpansionShape(parentExclusionMask: bigint, clueRestricted: boolean): GroupedExpansionShape {
        const { totalWeight, clueIncompatibleWeight } = this.buildScratchGroups(parentExclusionMask, clueRestricted);
        const childExclusionMasks = new BigUint64Array(this.groupCount);
        const edgeWeights = new Uint32Array(this.groupCount);
        const emissions = new Array<FlexEmission>(this.groupCount);
        for (let groupIndex = 0; groupIndex < this.groupCount; groupIndex++) {
            this.sortScratchAlternatives(groupIndex);
            childExclusionMasks[groupIndex] = this.scratchGroupMasks[groupIndex]!;
            edgeWeights[groupIndex] = this.scratchGroupWeights[groupIndex]!;
            emissions[groupIndex] = this.createPreparedGroupEmission(groupIndex);
        }

        return {
            totalWeight,
            clueIncompatibleWeight,
            groupCount: this.groupCount,
            childExclusionMasks,
            edgeWeights,
            emissions: Object.freeze(emissions)
        };
    }

    private buildScratchGroups(parentExclusionMask: bigint, clueRestricted: boolean): {
        readonly totalWeight: number;
        readonly clueIncompatibleWeight: number;
    } {
        let totalWeight = 0;
        let clueIncompatibleWeight = 0;
        this.resetScratchGroups();
        this.groupingBuildCount++;

        const entries = this.pool.entries;
        for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
            const entry = entries[entryIndex]!;
            if ((parentExclusionMask & entry.idBit) !== 0n) continue;

            totalWeight += entry.weight;
            if (clueRestricted && !this.canSelectBeforeTargetClue(entry)) {
                clueIncompatibleWeight += entry.weight;
                continue;
            }

            const childExclusionMask = parentExclusionMask | entry.blocksBitset;
            const groupIndex = this.getOrCreateScratchGroup(childExclusionMask);
            this.addScratchAlternative(groupIndex, entry.packedEnchant, entry.weight);
            this.scratchGroupWeights[groupIndex] = (this.scratchGroupWeights[groupIndex] ?? 0) + entry.weight;
        }

        this.groupedEdgeCount += this.groupCount;
        return { totalWeight, clueIncompatibleWeight };
    }

    private createPreparedGroupEmission(groupIndex: number): FlexEmission {
        const alternatives = this.scratchGroupPackedEnchants[groupIndex]!;
        const alternativeWeights = this.scratchGroupAlternativeWeights[groupIndex]!;
        return alternatives.length === 1
            ? this.programs.prepareFixedEmission(alternatives[0]! as PackedEnchant)
            : this.programs.prepareCanonicalChoiceFromArrays(alternatives, alternativeWeights, alternatives.length);
    }

    private createGroupedChildIdFromScratch(
        groupIndex: number,
        parentNodeIndex: number,
        childLevel: number,
        childCount: number
    ): FlexNodeId {
        const childExclusionMask = this.scratchGroupMasks[groupIndex]!;
        if (this.stateIdentityMode === 'reduced') {
            const identityProgramId = 0 as FlexProgramId;
            const stateKey = this.createNodeStateKey(childLevel, childCount);
            const existing = this.nodeIndex.get(childExclusionMask, stateKey, identityProgramId);
            if (existing !== undefined) return existing;
            const parentProgramId = this.programIds[parentNodeIndex]!;
            const childProgramId = this.programs.appendPreparedEmission(parentProgramId, this.createPreparedGroupEmission(groupIndex));
            return this.createNodeId(childExclusionMask, childLevel, childCount, childProgramId, identityProgramId);
        }

        const parentProgramId = this.programIds[parentNodeIndex]!;
        const childProgramId = this.programs.appendPreparedEmission(parentProgramId, this.createPreparedGroupEmission(groupIndex));
        return this.getOrCreateNodeId(
            childExclusionMask,
            childLevel,
            childCount,
            childProgramId
        );
    }

    private createGroupedChildId(
        shape: GroupedExpansionShape,
        groupIndex: number,
        parentNodeIndex: number,
        childLevel: number,
        childCount: number
    ): FlexNodeId {
        const childExclusionMask = shape.childExclusionMasks[groupIndex]!;
        if (this.stateIdentityMode === 'reduced') {
            const identityProgramId = 0 as FlexProgramId;
            const stateKey = this.createNodeStateKey(childLevel, childCount);
            const existing = this.nodeIndex.get(childExclusionMask, stateKey, identityProgramId);
            if (existing !== undefined) return existing;
            const parentProgramId = this.programIds[parentNodeIndex]!;
            const childProgramId = this.programs.appendPreparedEmission(parentProgramId, shape.emissions[groupIndex]!);
            return this.createNodeId(childExclusionMask, childLevel, childCount, childProgramId, identityProgramId);
        }

        const parentProgramId = this.programIds[parentNodeIndex]!;
        const childProgramId = this.programs.appendPreparedEmission(parentProgramId, shape.emissions[groupIndex]!);
        const childId = this.getOrCreateNodeId(
            childExclusionMask,
            childLevel,
            childCount,
            childProgramId
        );

        return childId;
    }

    private createSearchExpansion(
        nodeId: FlexNodeId,
        probContinue: bigint,
        totalWeight: number,
        edgeWeights: ArrayLike<number>,
        edgeChildIds: ArrayLike<number>,
        edgeCount: number,
        clueIncompatibleWeight: number,
        terminalReason: FlexExpansion['terminalReason'],
        useScratch: boolean
    ): FlexSearchExpansion {
        const programId = this.getProgramId(nodeId);
        this.searchExpansionCount++;

        if (useScratch) {
            this.scratchExpansion.nodeId = nodeId;
            this.scratchExpansion.programId = programId;
            this.scratchExpansion.nodeKind = this.programs.hasChoice(programId) ? 'plex' : 'solid';
            this.scratchExpansion.count = this.getNodeCount(nodeId);
            this.scratchExpansion.probContinue = probContinue;
            this.scratchExpansion.totalWeight = totalWeight;
            this.scratchExpansion.edgeCount = edgeCount;
            this.scratchExpansion.edgeWeights = edgeWeights;
            this.scratchExpansion.edgeChildIds = edgeChildIds;
            this.scratchExpansion.clueIncompatibleWeight = clueIncompatibleWeight;
            this.scratchExpansion.terminalReason = terminalReason;
            return this.scratchExpansion;
        }

        return {
            nodeId,
            programId,
            nodeKind: this.programs.hasChoice(programId) ? 'plex' : 'solid',
            count: this.getNodeCount(nodeId),
            probContinue,
            totalWeight,
            edgeCount,
            edgeWeights,
            edgeChildIds,
            clueIncompatibleWeight,
            terminalReason
        };
    }

    private getScratchEdgeWeights(required: number): Uint32Array {
        if (this.scratchEdgeWeights.length < required) {
            this.scratchEdgeWeights = new Uint32Array(required);
        }
        return this.scratchEdgeWeights;
    }

    private getScratchEdgeChildIds(required: number): Int32Array {
        if (this.scratchEdgeChildIds.length < required) {
            this.scratchEdgeChildIds = new Int32Array(required);
        }
        return this.scratchEdgeChildIds;
    }

    private createDebugExpansion(expansion: FlexSearchExpansion): FlexExpansion {
        const edges = new Array<FlexEdge>(expansion.edgeCount);
        for (let edgeIndex = 0; edgeIndex < expansion.edgeCount; edgeIndex++) {
            edges[edgeIndex] = Object.freeze({
                weight: expansion.edgeWeights[edgeIndex]!,
                childId: expansion.edgeChildIds[edgeIndex]! as FlexNodeId
            });
        }

        return Object.freeze({
            node: this.createNode(expansion.nodeId),
            probContinue: expansion.probContinue,
            totalWeight: expansion.totalWeight,
            edges: Object.freeze(edges),
            clueIncompatibleWeight: expansion.clueIncompatibleWeight,
            terminalReason: expansion.terminalReason
        });
    }

    private resetScratchGroups(): void {
        this.groupCount = 0;
    }

    private getOrCreateScratchGroup(childExclusionMask: bigint): number {
        for (let groupIndex = 0; groupIndex < this.groupCount; groupIndex++) {
            if (this.scratchGroupMasks[groupIndex] === childExclusionMask) return groupIndex;
        }

        const groupIndex = this.groupCount++;
        this.scratchGroupMasks[groupIndex] = childExclusionMask;
        this.scratchGroupWeights[groupIndex] = 0;
        this.scratchGroupPackedEnchants[groupIndex] ??= [];
        this.scratchGroupAlternativeWeights[groupIndex] ??= [];
        this.scratchGroupPackedEnchants[groupIndex]!.length = 0;
        this.scratchGroupAlternativeWeights[groupIndex]!.length = 0;
        return groupIndex;
    }

    private addScratchAlternative(groupIndex: number, packedEnchant: PackedEnchant, weight: number): void {
        const packedEnchants = this.scratchGroupPackedEnchants[groupIndex]!;
        const weights = this.scratchGroupAlternativeWeights[groupIndex]!;
        for (let index = 0; index < packedEnchants.length; index++) {
            if (packedEnchants[index] !== packedEnchant) continue;
            weights[index] = (weights[index] ?? 0) + weight;
            return;
        }

        packedEnchants.push(packedEnchant);
        weights.push(weight);
        this.groupedAlternativeCount++;
    }

    private sortScratchAlternatives(groupIndex: number): void {
        const packedEnchants = this.scratchGroupPackedEnchants[groupIndex]!;
        const weights = this.scratchGroupAlternativeWeights[groupIndex]!;
        for (let index = 1; index < packedEnchants.length; index++) {
            const packedEnchant = packedEnchants[index]!;
            const weight = weights[index]!;
            let cursor = index - 1;
            while (cursor >= 0 && packedEnchants[cursor]! > packedEnchant) {
                packedEnchants[cursor + 1] = packedEnchants[cursor]!;
                weights[cursor + 1] = weights[cursor]!;
                cursor--;
            }
            packedEnchants[cursor + 1] = packedEnchant;
            weights[cursor + 1] = weight;
        }
    }

    private programGuaranteesTargetClue(programId: FlexProgramId): boolean {
        const targetClueId = this.targetClueId;
        if (targetClueId === undefined) return false;

        return this.programs.guaranteesTargetClue(programId, targetClueId);
    }

    private canSelectBeforeTargetClue(entry: SearchPoolEntry): boolean {
        const targetClueId = this.targetClueId;
        if (targetClueId === undefined) return true;
        if (entry.packedEnchant === targetClueId) return true;

        const targetEnchantId = this.targetClueEnchantId;
        if (targetEnchantId === undefined) return true;
        if (entry.enchantId === targetEnchantId) return false;

        return (this.targetClueConflictBitset & entry.idBit) === 0n;
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

        return this.createNodeId(exclusionMask, currentLevel, count, programId, identityProgramId);
    }

    private createNodeId(
        exclusionMask: bigint,
        currentLevel: number,
        count: number,
        programId: FlexProgramId,
        identityProgramId: FlexProgramId
    ): FlexNodeId {
        const stateKey = this.createNodeStateKey(currentLevel, count);
        const id = this.counts.length as FlexNodeId;
        this.exclusionMasks.push(exclusionMask);
        this.currentLevels.push(currentLevel);
        this.counts.push(count);
        this.programIds.push(programId);
        this.expansionCache.push(undefined);
        this.debugExpansionCache.push(undefined);
        this.nodeIndex.set(exclusionMask, stateKey, identityProgramId, id);
        return id;
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

function sortEdgeArrays(edgeWeights: Uint32Array, edgeChildIds: Int32Array, edgeCount: number): void {
    for (let index = 1; index < edgeCount; index++) {
        const weight = edgeWeights[index]!;
        const childId = edgeChildIds[index]!;
        let cursor = index - 1;
        while (
            cursor >= 0
            && (edgeWeights[cursor]! < weight
                || (edgeWeights[cursor] === weight && edgeChildIds[cursor]! > childId))
        ) {
            edgeWeights[cursor + 1] = edgeWeights[cursor]!;
            edgeChildIds[cursor + 1] = edgeChildIds[cursor]!;
            cursor--;
        }
        edgeWeights[cursor + 1] = weight;
        edgeChildIds[cursor + 1] = childId;
    }
}
