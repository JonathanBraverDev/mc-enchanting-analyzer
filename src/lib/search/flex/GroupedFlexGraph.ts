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
    FlexOptimizationControls,
    FlexProgramId,
    FlexRankProfileId,
    FlexSearchExpansion,
    FlexSearchExpansionConsumer,
    FlexStateIdentityMode
} from '#lib/search/flex/FlexTypes.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';
import { FLEX_GRAPH_INDEX_CONFIG, FLEX_GRAPH_TRAVERSAL, FLEX_HASH_CONFIG, FLEX_INDEX_SENTINELS } from '#lib/search/flex/FlexConstants.js';

const FLEX_NODE_STATE_COUNT_STRIDE = ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM + 1;
const EMPTY_EDGE_WEIGHTS = new Uint32Array(0);
const EMPTY_EDGE_CHILD_IDS = new Int32Array(0);
const SAME_GRAPH_EDGE_ID = -1;
const REDUCED_IDENTITY_PROGRAM_ID = 0 as FlexProgramId;
const INITIAL_EXPANSION_NODE_ID = 0 as FlexNodeId;
const INITIAL_EXPANSION_PROGRAM_ID = REDUCED_IDENTITY_PROGRAM_ID;
const INITIAL_EXPANSION_PROB_CONTINUE = 0n;
const INITIAL_EXPANSION_TOTAL_WEIGHT = 0;
const INITIAL_EXPANSION_EDGE_COUNT = 0;
const INITIAL_EXPANSION_CLUE_INCOMPATIBLE_WEIGHT = 0;
const SCRATCH_ENTRY_INDEX_NONE = FLEX_INDEX_SENTINELS.MISSING_INDEX;

interface GroupedExpansionShape {
    readonly totalWeight: number;
    readonly clueIncompatibleWeight: number;
    readonly groupCount: number;
    readonly childExclusionMasks: ArrayLike<bigint>;
    readonly childExclusionMaskLows: ArrayLike<number>;
    readonly childExclusionMaskHighs: ArrayLike<number>;
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
    edgeGraphIds?: ArrayLike<number> | undefined;
    clueIncompatibleWeight?: number | undefined;
    terminalReason: FlexExpansion['terminalReason'];
}

export interface GroupedFlexChildRouteRequest {
    readonly pool: SearchPool;
    readonly parentNodeId: FlexNodeId;
    readonly parentProgramId: FlexProgramId;
    readonly childProgramId: FlexProgramId;
    readonly childExclusionMask: bigint;
    readonly childLevel: number;
    readonly childCount: number;
}

export interface GroupedFlexChildRoute {
    readonly graphId: number;
    readonly nodeId: FlexNodeId;
}

interface InternalGroupedFlexChildRoute {
    readonly graphId: number;
    readonly nodeId: FlexNodeId;
}

class FlexNodeIndex {
    private exclusionMasks: bigint[] = [];
    private exclusionMaskLows: Uint32Array;
    private exclusionMaskHighs: Uint32Array;
    private stateKeys: Int32Array;
    private programIds: Int32Array;
    private values: Int32Array;
    private used: Uint8Array;
    private mask: number;
    private resizeAt: number;
    private count = 0;
    private _growCount = 0;

    public constructor(capacity: number = FLEX_GRAPH_INDEX_CONFIG.INITIAL_CAPACITY) {
        const size = FlexNodeIndex.nextPowerOfTwo(capacity);
        this.exclusionMaskLows = new Uint32Array(size);
        this.exclusionMaskHighs = new Uint32Array(size);
        this.stateKeys = new Int32Array(size);
        this.programIds = new Int32Array(size);
        this.values = new Int32Array(size);
        this.values.fill(FLEX_INDEX_SENTINELS.MISSING_INDEX);
        this.used = new Uint8Array(size);
        this.mask = size - 1;
        this.resizeAt = Math.floor(size * FLEX_GRAPH_INDEX_CONFIG.MAX_LOAD_FACTOR);
    }

    public get(exclusionMask: bigint, stateKey: number, programId: FlexProgramId): FlexNodeId | undefined {
        return this.getParts(exclusionMaskLow(exclusionMask), exclusionMaskHigh(exclusionMask), stateKey, programId);
    }

    public getParts(maskLow: number, maskHigh: number, stateKey: number, programId: FlexProgramId): FlexNodeId | undefined {
        let index = this.hashParts(maskLow, maskHigh, stateKey, programId) & this.mask;
        while (this.used[index] !== FLEX_INDEX_SENTINELS.EMPTY_SLOT) {
            if (
                this.stateKeys[index] === stateKey
                && this.programIds[index] === programId
                && this.exclusionMaskLows[index] === maskLow
                && this.exclusionMaskHighs[index] === maskHigh
            ) {
                const value = this.values[index]!;
                return value === FLEX_INDEX_SENTINELS.MISSING_INDEX ? undefined : value as FlexNodeId;
            }
            index = (index + 1) & this.mask;
        }
        return undefined;
    }

    public set(exclusionMask: bigint, stateKey: number, programId: FlexProgramId, value: FlexNodeId): void {
        this.setParts(exclusionMask, exclusionMaskLow(exclusionMask), exclusionMaskHigh(exclusionMask), stateKey, programId, value);
    }

    public setParts(
        exclusionMask: bigint,
        maskLow: number,
        maskHigh: number,
        stateKey: number,
        programId: FlexProgramId,
        value: FlexNodeId
    ): void {
        if (this.count >= this.resizeAt) this.grow();
        this.insert(exclusionMask, maskLow, maskHigh, stateKey, programId, value);
    }

    public get growCount(): number {
        return this._growCount;
    }

    private insert(
        exclusionMask: bigint,
        maskLow: number,
        maskHigh: number,
        stateKey: number,
        programId: FlexProgramId,
        value: FlexNodeId
    ): void {
        let index = this.hashParts(maskLow, maskHigh, stateKey, programId) & this.mask;
        while (this.used[index] !== FLEX_INDEX_SENTINELS.EMPTY_SLOT) {
            if (
                this.stateKeys[index] === stateKey
                && this.programIds[index] === programId
                && this.exclusionMaskLows[index] === maskLow
                && this.exclusionMaskHighs[index] === maskHigh
            ) {
                this.values[index] = value;
                return;
            }
            index = (index + 1) & this.mask;
        }

        this.used[index] = FLEX_INDEX_SENTINELS.OCCUPIED_SLOT;
        this.exclusionMasks[index] = exclusionMask;
        this.exclusionMaskLows[index] = maskLow;
        this.exclusionMaskHighs[index] = maskHigh;
        this.stateKeys[index] = stateKey;
        this.programIds[index] = programId;
        this.values[index] = value;
        this.count++;
    }

    private grow(): void {
        this._growCount++;
        const oldMasks = this.exclusionMasks;
        const oldMaskLows = this.exclusionMaskLows;
        const oldMaskHighs = this.exclusionMaskHighs;
        const oldStateKeys = this.stateKeys;
        const oldProgramIds = this.programIds;
        const oldValues = this.values;
        const oldUsed = this.used;
        const nextSize = oldStateKeys.length * FLEX_GRAPH_INDEX_CONFIG.GROWTH_FACTOR;

        this.exclusionMasks = [];
        this.exclusionMaskLows = new Uint32Array(nextSize);
        this.exclusionMaskHighs = new Uint32Array(nextSize);
        this.stateKeys = new Int32Array(nextSize);
        this.programIds = new Int32Array(nextSize);
        this.values = new Int32Array(nextSize);
        this.values.fill(FLEX_INDEX_SENTINELS.MISSING_INDEX);
        this.used = new Uint8Array(nextSize);
        this.mask = nextSize - 1;
        this.resizeAt = Math.floor(nextSize * FLEX_GRAPH_INDEX_CONFIG.MAX_LOAD_FACTOR);
        this.count = 0;

        for (let i = 0; i < oldStateKeys.length; i++) {
            if (oldUsed[i] !== FLEX_INDEX_SENTINELS.EMPTY_SLOT) {
                this.insert(
                    oldMasks[i]!,
                    oldMaskLows[i]!,
                    oldMaskHighs[i]!,
                    oldStateKeys[i]!,
                    oldProgramIds[i]! as FlexProgramId,
                    oldValues[i]! as FlexNodeId
                );
            }
        }
    }

    private hashParts(maskLow: number, maskHigh: number, stateKey: number, programId: FlexProgramId): number {
        let h = (maskLow
            ^ Math.imul(maskHigh, FLEX_HASH_CONFIG.GOLDEN_RATIO_32)
            ^ Math.imul(stateKey, FLEX_HASH_CONFIG.STATE_KEY_MULTIPLIER)
            ^ Math.imul(programId, FLEX_HASH_CONFIG.PROGRAM_KEY_MULTIPLIER)) >>> 0;
        h ^= h >>> FLEX_HASH_CONFIG.AVALANCHE_SHIFT_1;
        h = Math.imul(h, FLEX_HASH_CONFIG.AVALANCHE_MULTIPLIER_1) >>> 0;
        h ^= h >>> FLEX_HASH_CONFIG.AVALANCHE_SHIFT_2;
        h = Math.imul(h, FLEX_HASH_CONFIG.AVALANCHE_MULTIPLIER_2) >>> 0;
        return (h ^ (h >>> FLEX_HASH_CONFIG.AVALANCHE_SHIFT_1)) >>> 0;
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
    readonly optimizationControls?: FlexOptimizationControls | undefined;
    readonly rankProfileId?: FlexRankProfileId | undefined;
    readonly routeChild?: ((request: GroupedFlexChildRouteRequest) => GroupedFlexChildRoute | undefined) | undefined;
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
    private readonly debugExpansionCache: Array<FlexExpansion | undefined> = [];
    private readonly shapeCache = new Map<bigint, GroupedExpansionShape>();
    private readonly scratchGroupMasks: bigint[] = [];
    private readonly scratchGroupMaskLows: number[] = [];
    private readonly scratchGroupMaskHighs: number[] = [];
    private readonly scratchGroupWeights: number[] = [];
    private readonly scratchGroupAlternativeCounts: number[] = [];
    private readonly scratchGroupFirstPackedEnchants: number[] = [];
    private readonly scratchGroupFirstEntryIndexes: number[] = [];
    private readonly scratchGroupLastEntryIndexes: number[] = [];
    private readonly scratchGroupPackedEnchants: number[][] = [];
    private readonly scratchGroupAlternativeWeights: number[][] = [];
    private scratchEntryNextIndexes = new Int32Array(0);
    private scratchEdgeWeights = EMPTY_EDGE_WEIGHTS;
    private scratchEdgeChildIds = EMPTY_EDGE_CHILD_IDS;
    private scratchEdgeGraphIds = new Int32Array(0);
    private readonly scratchExpansion: MutableFlexSearchExpansion = {
        nodeId: INITIAL_EXPANSION_NODE_ID,
        programId: INITIAL_EXPANSION_PROGRAM_ID,
        nodeKind: 'solid',
        count: FLEX_GRAPH_TRAVERSAL.ROOT_ENCHANT_COUNT,
        probContinue: INITIAL_EXPANSION_PROB_CONTINUE,
        totalWeight: INITIAL_EXPANSION_TOTAL_WEIGHT,
        edgeCount: INITIAL_EXPANSION_EDGE_COUNT,
        edgeWeights: EMPTY_EDGE_WEIGHTS,
        edgeChildIds: EMPTY_EDGE_CHILD_IDS,
        edgeGraphIds: undefined,
        clueIncompatibleWeight: INITIAL_EXPANSION_CLUE_INCOMPATIBLE_WEIGHT,
        terminalReason: null
    };
    private readonly stateIdentityMode: FlexStateIdentityMode;
    private readonly allowConflictMerge: boolean;
    private readonly rankProfileId: FlexRankProfileId | undefined;
    private readonly routeChild: ((request: GroupedFlexChildRouteRequest) => GroupedFlexChildRoute | undefined) | undefined;
    private readonly targetClueId: number | undefined;
    private readonly targetClueEnchantId: number | undefined;
    private readonly targetClueConflictBitset: bigint;
    private searchExpansionCount = 0;
    private groupCount = 0;
    private shapeCacheHitCount = 0;
    private shapeCacheMissCount = 0;
    private directExpansionBuildCount = 0;
    private shapedExpansionBuildCount = 0;
    private groupingBuildCount = 0;
    private groupedEdgeCount = 0;
    private groupedAlternativeCount = 0;
    private collectedAlternativeDetailCount = 0;
    private singletonGroupCount = 0;
    private choiceGroupCount = 0;
    private nodeCreateCount = 0;
    private nodeReuseCount = 0;
    private preparedFixedEmissionCount = 0;
    private preparedChoiceEmissionCount = 0;
    private preparedChoiceAlternativeCount = 0;
    private lazyChoiceEmissionScanCount = 0;
    private lazyChoiceEmissionMemberVisitCount = 0;
    private shapePreparedEmissionAppendCount = 0;
    private debugExpansionCount = 0;
    private solidNodeCount = 0;
    private plexNodeCount = 0;

    public constructor(
        private readonly kernel: RegistryKernel,
        pool: SearchPool,
        private readonly programs: FlexProgramStore,
        options: GroupedFlexGraphOptions = {}
    ) {
        this.pool = pool;
        this.rankProfileId = options.rankProfileId;
        this.routeChild = options.routeChild;
        this.allowConflictMerge = options.optimizationControls?.allowConflictMerge ?? true;
        this.stateIdentityMode = this.allowConflictMerge
            ? options.stateIdentityMode ?? 'reduced'
            : 'program';
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
            FLEX_GRAPH_TRAVERSAL.ROOT_EXCLUSION_MASK,
            initialLevel,
            FLEX_GRAPH_TRAVERSAL.ROOT_ENCHANT_COUNT,
            this.programs.empty
        ));
    }

    public getExpansion(nodeId: FlexNodeId): FlexExpansion {
        this.assertNode(nodeId);
        const cached = this.debugExpansionCache[nodeId as number];
        if (cached) return cached;

        const expansion = this.createDebugExpansion(this.createScratchSearchExpansion(nodeId));
        this.debugExpansionCache[nodeId as number] = expansion;
        this.debugExpansionCount++;
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

    public getNodeKind(nodeId: FlexNodeId): FlexNode['kind'] {
        this.assertNode(nodeId);
        return this.programs.hasChoice(this.programIds[nodeId as number]!) ? 'plex' : 'solid';
    }

    public getNodeCurrentLevel(nodeId: FlexNodeId): number {
        this.assertNode(nodeId);
        return this.currentLevels[nodeId as number]!;
    }

    public getNodeExclusionMask(nodeId: FlexNodeId): bigint {
        this.assertNode(nodeId);
        return this.exclusionMasks[nodeId as number]!;
    }

    public getOrCreateRoutedNode(
        exclusionMask: bigint,
        currentLevel: number,
        count: number,
        programId: FlexProgramId
    ): FlexNode {
        return this.createNode(this.getOrCreateNodeId(exclusionMask, currentLevel, count, programId));
    }

    public getMemoryStats(): FlexGraphMemoryStats {
        return {
            nodeCount: this.size,
            solidNodeCount: this.solidNodeCount,
            plexNodeCount: this.plexNodeCount,
            searchExpansionCount: this.searchExpansionCount,
            debugExpansionCount: this.debugExpansionCount,
            shapeCacheHitCount: this.shapeCacheHitCount,
            shapeCacheMissCount: this.shapeCacheMissCount,
            directExpansionBuildCount: this.directExpansionBuildCount,
            shapedExpansionBuildCount: this.shapedExpansionBuildCount,
            groupingBuildCount: this.groupingBuildCount,
            groupedEdgeCount: this.groupedEdgeCount,
            groupedAlternativeCount: this.groupedAlternativeCount,
            collectedAlternativeDetailCount: this.collectedAlternativeDetailCount,
            singletonGroupCount: this.singletonGroupCount,
            choiceGroupCount: this.choiceGroupCount,
            nodeCreateCount: this.nodeCreateCount,
            nodeReuseCount: this.nodeReuseCount,
            preparedFixedEmissionCount: this.preparedFixedEmissionCount,
            preparedChoiceEmissionCount: this.preparedChoiceEmissionCount,
            preparedChoiceAlternativeCount: this.preparedChoiceAlternativeCount,
            lazyChoiceEmissionScanCount: this.lazyChoiceEmissionScanCount,
            lazyChoiceEmissionMemberVisitCount: this.lazyChoiceEmissionMemberVisitCount,
            shapePreparedEmissionAppendCount: this.shapePreparedEmissionAppendCount,
            nodeIndexGrowCount: this.nodeIndex.growCount
        };
    }

    private createScratchSearchExpansion(nodeId: FlexNodeId): FlexSearchExpansion {
        return this.createSearchExpansionForNode(nodeId);
    }

    private createSearchExpansionForNode(nodeId: FlexNodeId): FlexSearchExpansion {
        return this.counts[nodeId as number] === FLEX_GRAPH_TRAVERSAL.ROOT_ENCHANT_COUNT
            ? this.createRootSearchExpansion(nodeId)
            : this.createNonRootSearchExpansion(nodeId);
    }

    private createRootSearchExpansion(nodeId: FlexNodeId): FlexSearchExpansion {
        const nodeIndex = nodeId as number;
        const currentLevel = this.currentLevels[nodeIndex]!;
        return this.createGroupedSearchExpansion(
            nodeId,
            PRECISION,
            FLEX_GRAPH_TRAVERSAL.ROOT_EXCLUSION_MASK,
            currentLevel,
            FLEX_GRAPH_TRAVERSAL.ENCHANT_COUNT_INCREMENT,
            null
        );
    }

    private createNonRootSearchExpansion(nodeId: FlexNodeId): FlexSearchExpansion {
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
                terminalReason === 'max-enchants' ? 'overflow' : null
            );
        }

        const childLevel = Math.floor(currentLevel / this.kernel.additionalEnchantmentLevelDivisor);
        const childCount = count + FLEX_GRAPH_TRAVERSAL.ENCHANT_COUNT_INCREMENT;
        return this.createGroupedSearchExpansion(nodeId, probContinue, exclusionMask, childLevel, childCount, null);
    }

    private createGroupedSearchExpansion(
        nodeId: FlexNodeId,
        probContinue: bigint,
        parentExclusionMask: bigint,
        childLevel: number,
        childCount: number,
        terminalReason: FlexExpansion['terminalReason']
    ): FlexSearchExpansion {
        const parentNodeIndex = nodeId as number;
        const parentProgramId = this.programIds[parentNodeIndex]!;
        const clueRestricted = this.targetClueId !== undefined && !this.programGuaranteesTargetClue(parentProgramId);
        const shapeKey = this.createGroupedExpansionShapeKey(parentExclusionMask, clueRestricted);
        const cached = this.shapeCache.get(shapeKey);
        if (cached) {
            this.shapeCacheHitCount++;
            this.shapedExpansionBuildCount++;
            return this.createGroupedSearchExpansionFromShape(
                nodeId,
                probContinue,
                childLevel,
                childCount,
                terminalReason,
                parentNodeIndex,
                cached
            );
        }
        this.shapeCacheMissCount++;

        if (parentExclusionMask !== 0n) {
            this.directExpansionBuildCount++;
            return this.createDirectGroupedSearchExpansion(
                nodeId,
                probContinue,
                parentExclusionMask,
                childLevel,
                childCount,
                terminalReason,
                parentNodeIndex,
                clueRestricted
            );
        }

        const shape = this.buildGroupedExpansionShape(parentExclusionMask, clueRestricted);
        this.shapeCache.set(shapeKey, shape);
        this.shapedExpansionBuildCount++;
        return this.createGroupedSearchExpansionFromShape(
            nodeId,
            probContinue,
            childLevel,
            childCount,
            terminalReason,
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
        parentNodeIndex: number,
        shape: GroupedExpansionShape
    ): FlexSearchExpansion {
        const edgeWeights = this.getScratchEdgeWeights(shape.groupCount);
        const edgeChildIds = this.getScratchEdgeChildIds(shape.groupCount);
        const edgeGraphIds = this.routeChild === undefined ? undefined : this.getScratchEdgeGraphIds(shape.groupCount);
        let hasRoutedEdges = false;

        for (let groupIndex = 0; groupIndex < shape.groupCount; groupIndex++) {
            const childRoute = this.createGroupedChildRoute(shape, groupIndex, parentNodeIndex, childLevel, childCount);
            edgeWeights[groupIndex] = shape.edgeWeights[groupIndex]!;
            edgeChildIds[groupIndex] = childRoute.nodeId as number;
            if (edgeGraphIds !== undefined) {
                edgeGraphIds[groupIndex] = childRoute.graphId;
                if (childRoute.graphId !== SAME_GRAPH_EDGE_ID) hasRoutedEdges = true;
            }
        }
        sortEdgeArrays(edgeWeights, edgeChildIds, shape.groupCount, edgeGraphIds);

        return this.createSearchExpansion(
            nodeId,
            probContinue,
            shape.totalWeight,
            edgeWeights,
            edgeChildIds,
            shape.groupCount,
            shape.clueIncompatibleWeight,
            terminalReason,
            hasRoutedEdges ? edgeGraphIds : undefined
        );
    }

    private createDirectGroupedSearchExpansion(
        nodeId: FlexNodeId,
        probContinue: bigint,
        parentExclusionMask: bigint,
        childLevel: number,
        childCount: number,
        terminalReason: FlexExpansion['terminalReason'],
        parentNodeIndex: number,
        clueRestricted: boolean
    ): FlexSearchExpansion {
        const collectAlternatives = this.stateIdentityMode !== 'reduced';
        const { totalWeight, clueIncompatibleWeight } = this.buildScratchGroups(parentExclusionMask, clueRestricted, collectAlternatives);
        const edgeWeights = this.getScratchEdgeWeights(this.groupCount);
        const edgeChildIds = this.getScratchEdgeChildIds(this.groupCount);
        const edgeGraphIds = this.routeChild === undefined ? undefined : this.getScratchEdgeGraphIds(this.groupCount);
        let hasRoutedEdges = false;

        for (let groupIndex = 0; groupIndex < this.groupCount; groupIndex++) {
            const childRoute = this.createGroupedChildRouteFromScratch(
                groupIndex,
                parentNodeIndex,
                childLevel,
                childCount,
                collectAlternatives
            );
            edgeWeights[groupIndex] = this.scratchGroupWeights[groupIndex]!;
            edgeChildIds[groupIndex] = childRoute.nodeId as number;
            if (edgeGraphIds !== undefined) {
                edgeGraphIds[groupIndex] = childRoute.graphId;
                if (childRoute.graphId !== SAME_GRAPH_EDGE_ID) hasRoutedEdges = true;
            }
        }
        sortEdgeArrays(edgeWeights, edgeChildIds, this.groupCount, edgeGraphIds);

        return this.createSearchExpansion(
            nodeId,
            probContinue,
            totalWeight,
            edgeWeights,
            edgeChildIds,
            this.groupCount,
            clueIncompatibleWeight,
            terminalReason,
            hasRoutedEdges ? edgeGraphIds : undefined
        );
    }

    private createGroupedExpansionShapeKey(parentExclusionMask: bigint, clueRestricted: boolean): bigint {
        return (parentExclusionMask << 1n) | (clueRestricted ? 1n : 0n);
    }

    private buildGroupedExpansionShape(parentExclusionMask: bigint, clueRestricted: boolean): GroupedExpansionShape {
        const { totalWeight, clueIncompatibleWeight } = this.buildScratchGroups(parentExclusionMask, clueRestricted, true);
        const childExclusionMasks = new BigUint64Array(this.groupCount);
        const childExclusionMaskLows = new Uint32Array(this.groupCount);
        const childExclusionMaskHighs = new Uint32Array(this.groupCount);
        const edgeWeights = new Uint32Array(this.groupCount);
        const emissions = new Array<FlexEmission>(this.groupCount);
        for (let groupIndex = 0; groupIndex < this.groupCount; groupIndex++) {
            childExclusionMasks[groupIndex] = this.scratchGroupMasks[groupIndex]!;
            childExclusionMaskLows[groupIndex] = this.scratchGroupMaskLows[groupIndex]!;
            childExclusionMaskHighs[groupIndex] = this.scratchGroupMaskHighs[groupIndex]!;
            edgeWeights[groupIndex] = this.scratchGroupWeights[groupIndex]!;
            emissions[groupIndex] = this.createPreparedGroupEmission(groupIndex);
        }

        return {
            totalWeight,
            clueIncompatibleWeight,
            groupCount: this.groupCount,
            childExclusionMasks,
            childExclusionMaskLows,
            childExclusionMaskHighs,
            edgeWeights,
            emissions: Object.freeze(emissions)
        };
    }

    private buildScratchGroups(parentExclusionMask: bigint, clueRestricted: boolean, collectAlternatives: boolean): {
        readonly totalWeight: number;
        readonly clueIncompatibleWeight: number;
    } {
        let totalWeight = 0;
        let clueIncompatibleWeight = 0;
        this.resetScratchGroups();
        this.groupingBuildCount++;

        const entries = this.pool.entries;
        const scratchEntryNextIndexes = this.getScratchEntryNextIndexes();
        for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
            const entry = entries[entryIndex]!;
            if ((parentExclusionMask & entry.idBit) !== 0n) continue;

            totalWeight += entry.weight;
            if (clueRestricted && !this.canSelectBeforeTargetClue(entry)) {
                clueIncompatibleWeight += entry.weight;
                continue;
            }

            const childExclusionMask = parentExclusionMask | entry.blocksBitset;
            const groupIndex = this.allowConflictMerge
                ? this.getOrCreateScratchGroup(childExclusionMask, collectAlternatives)
                : this.createScratchGroup(childExclusionMask, collectAlternatives);
            this.addScratchGroupMember(groupIndex, entryIndex, scratchEntryNextIndexes);
            if (collectAlternatives) {
                this.addScratchAlternative(groupIndex, entry.packedEnchant, entry.weight);
            } else {
                this.addScratchAlternativeSummary(groupIndex, entry.packedEnchant);
            }
            this.scratchGroupWeights[groupIndex] = (this.scratchGroupWeights[groupIndex] ?? 0) + entry.weight;
        }

        this.groupedEdgeCount += this.groupCount;
        for (let groupIndex = 0; groupIndex < this.groupCount; groupIndex++) {
            const alternativeCount = collectAlternatives
                ? this.scratchGroupPackedEnchants[groupIndex]?.length ?? 0
                : this.scratchGroupAlternativeCounts[groupIndex] ?? 0;
            if (alternativeCount === 1) this.singletonGroupCount++;
            else if (alternativeCount > 1) this.choiceGroupCount++;
        }
        return { totalWeight, clueIncompatibleWeight };
    }

    private createPreparedGroupEmission(groupIndex: number): FlexEmission {
        this.sortScratchAlternatives(groupIndex);
        const alternatives = this.scratchGroupPackedEnchants[groupIndex]!;
        const alternativeWeights = this.scratchGroupAlternativeWeights[groupIndex]!;
        if (alternatives.length === 1) {
            this.preparedFixedEmissionCount++;
            return this.prepareSingletonEmission(alternatives[0]! as PackedEnchant);
        }

        this.preparedChoiceEmissionCount++;
        this.preparedChoiceAlternativeCount += alternatives.length;
        if (this.rankProfileId !== undefined) {
            return this.programs.prepareCanonicalRankChoiceFromPackedArrays(
                alternatives,
                alternativeWeights,
                alternatives.length,
                this.rankProfileId
            );
        }
        return this.programs.prepareCanonicalChoiceFromArrays(alternatives, alternativeWeights, alternatives.length);
    }

    private createPreparedGroupEmissionFromScratch(
        groupIndex: number,
        alternativesCollected: boolean
    ): FlexEmission {
        if (alternativesCollected) return this.createPreparedGroupEmission(groupIndex);

        const alternativeCount = this.scratchGroupAlternativeCounts[groupIndex] ?? 0;
        if (alternativeCount === 1) {
            this.preparedFixedEmissionCount++;
            return this.prepareSingletonEmission(this.scratchGroupFirstPackedEnchants[groupIndex]! as PackedEnchant);
        }

        this.lazyChoiceEmissionScanCount++;
        this.collectScratchAlternativesForGroup(groupIndex);
        return this.createPreparedGroupEmission(groupIndex);
    }

    private collectScratchAlternativesForGroup(groupIndex: number): void {
        this.resetScratchAlternativeDetails(groupIndex);

        const entries = this.pool.entries;
        const nextIndexes = this.scratchEntryNextIndexes;
        let entryIndex = this.scratchGroupFirstEntryIndexes[groupIndex] ?? SCRATCH_ENTRY_INDEX_NONE;
        while (entryIndex !== SCRATCH_ENTRY_INDEX_NONE) {
            this.lazyChoiceEmissionMemberVisitCount++;
            const entry = entries[entryIndex]!;
            this.addScratchAlternative(groupIndex, entry.packedEnchant, entry.weight, false);
            entryIndex = nextIndexes[entryIndex] ?? SCRATCH_ENTRY_INDEX_NONE;
        }
    }

    private prepareSingletonEmission(packedEnchant: PackedEnchant): FlexEmission {
        return this.rankProfileId === undefined
            ? this.programs.prepareFixedEmission(packedEnchant)
            : this.programs.prepareRankEmission(getEnchantId(packedEnchant), this.rankProfileId);
    }

    private createGroupedChildRouteFromScratch(
        groupIndex: number,
        parentNodeIndex: number,
        childLevel: number,
        childCount: number,
        alternativesCollected: boolean
    ): InternalGroupedFlexChildRoute {
        const childExclusionMask = this.scratchGroupMasks[groupIndex]!;
        const childExclusionMaskLow = this.scratchGroupMaskLows[groupIndex]!;
        const childExclusionMaskHigh = this.scratchGroupMaskHighs[groupIndex]!;
        const parentProgramId = this.programIds[parentNodeIndex]!;
        const emission = this.createPreparedGroupEmissionFromScratch(groupIndex, alternativesCollected);
        const childProgramId = this.programs.appendPreparedEmission(parentProgramId, emission);
        const routed = this.tryRouteChild(
            parentNodeIndex,
            parentProgramId,
            childProgramId,
            childExclusionMask,
            childLevel,
            childCount
        );
        if (routed) return routed;

        if (this.stateIdentityMode === 'reduced') {
            const identityProgramId = REDUCED_IDENTITY_PROGRAM_ID;
            const stateKey = this.createNodeStateKey(childLevel, childCount);
            const existing = this.nodeIndex.getParts(childExclusionMaskLow, childExclusionMaskHigh, stateKey, identityProgramId);
            if (existing !== undefined) {
                this.nodeReuseCount++;
                return { graphId: SAME_GRAPH_EDGE_ID, nodeId: existing };
            }
            return {
                graphId: SAME_GRAPH_EDGE_ID,
                nodeId: this.createNodeIdWithParts(
                    childExclusionMask,
                    childExclusionMaskLow,
                    childExclusionMaskHigh,
                    childLevel,
                    childCount,
                    childProgramId,
                    identityProgramId
                )
            };
        }

        return {
            graphId: SAME_GRAPH_EDGE_ID,
            nodeId: this.getOrCreateNodeIdWithParts(
                childExclusionMask,
                childExclusionMaskLow,
                childExclusionMaskHigh,
                childLevel,
                childCount,
                childProgramId
            )
        };
    }

    private createGroupedChildRoute(
        shape: GroupedExpansionShape,
        groupIndex: number,
        parentNodeIndex: number,
        childLevel: number,
        childCount: number
    ): InternalGroupedFlexChildRoute {
        const childExclusionMask = shape.childExclusionMasks[groupIndex]!;
        const childExclusionMaskLow = shape.childExclusionMaskLows[groupIndex]!;
        const childExclusionMaskHigh = shape.childExclusionMaskHighs[groupIndex]!;
        const parentProgramId = this.programIds[parentNodeIndex]!;
        this.shapePreparedEmissionAppendCount++;
        const childProgramId = this.programs.appendPreparedEmission(parentProgramId, shape.emissions[groupIndex]!);
        const routed = this.tryRouteChild(
            parentNodeIndex,
            parentProgramId,
            childProgramId,
            childExclusionMask,
            childLevel,
            childCount
        );
        if (routed) return routed;

        if (this.stateIdentityMode === 'reduced') {
            const identityProgramId = REDUCED_IDENTITY_PROGRAM_ID;
            const stateKey = this.createNodeStateKey(childLevel, childCount);
            const existing = this.nodeIndex.getParts(childExclusionMaskLow, childExclusionMaskHigh, stateKey, identityProgramId);
            if (existing !== undefined) {
                this.nodeReuseCount++;
                return { graphId: SAME_GRAPH_EDGE_ID, nodeId: existing };
            }
            return {
                graphId: SAME_GRAPH_EDGE_ID,
                nodeId: this.createNodeIdWithParts(
                    childExclusionMask,
                    childExclusionMaskLow,
                    childExclusionMaskHigh,
                    childLevel,
                    childCount,
                    childProgramId,
                    identityProgramId
                )
            };
        }

        return {
            graphId: SAME_GRAPH_EDGE_ID,
            nodeId: this.getOrCreateNodeIdWithParts(
                childExclusionMask,
                childExclusionMaskLow,
                childExclusionMaskHigh,
                childLevel,
                childCount,
                childProgramId
            )
        };
    }

    private tryRouteChild(
        parentNodeIndex: number,
        parentProgramId: FlexProgramId,
        childProgramId: FlexProgramId,
        childExclusionMask: bigint,
        childLevel: number,
        childCount: number
    ): InternalGroupedFlexChildRoute | undefined {
        const routeChild = this.routeChild;
        if (routeChild === undefined) return undefined;

        const routed = routeChild({
            pool: this.pool,
            parentNodeId: parentNodeIndex as FlexNodeId,
            parentProgramId,
            childProgramId,
            childExclusionMask,
            childLevel,
            childCount
        });
        if (routed === undefined) return undefined;
        return {
            graphId: routed.graphId,
            nodeId: routed.nodeId
        };
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
        edgeGraphIds?: ArrayLike<number> | undefined
    ): FlexSearchExpansion {
        const programId = this.getProgramId(nodeId);
        this.searchExpansionCount++;

        this.scratchExpansion.nodeId = nodeId;
        this.scratchExpansion.programId = programId;
        this.scratchExpansion.nodeKind = this.programs.hasChoice(programId) ? 'plex' : 'solid';
        this.scratchExpansion.count = this.getNodeCount(nodeId);
        this.scratchExpansion.probContinue = probContinue;
        this.scratchExpansion.totalWeight = totalWeight;
        this.scratchExpansion.edgeCount = edgeCount;
        this.scratchExpansion.edgeWeights = edgeWeights;
        this.scratchExpansion.edgeChildIds = edgeChildIds;
        this.scratchExpansion.edgeGraphIds = edgeGraphIds;
        this.scratchExpansion.clueIncompatibleWeight = clueIncompatibleWeight;
        this.scratchExpansion.terminalReason = terminalReason;
        return this.scratchExpansion;
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

    private getScratchEdgeGraphIds(required: number): Int32Array {
        if (this.scratchEdgeGraphIds.length < required) {
            this.scratchEdgeGraphIds = new Int32Array(required);
        }
        this.scratchEdgeGraphIds.fill(SAME_GRAPH_EDGE_ID, 0, required);
        return this.scratchEdgeGraphIds;
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

    private getOrCreateScratchGroup(childExclusionMask: bigint, collectAlternatives: boolean): number {
        for (let groupIndex = 0; groupIndex < this.groupCount; groupIndex++) {
            if (this.scratchGroupMasks[groupIndex] === childExclusionMask) return groupIndex;
        }

        return this.createScratchGroup(childExclusionMask, collectAlternatives);
    }

    private createScratchGroup(childExclusionMask: bigint, collectAlternatives: boolean): number {
        const groupIndex = this.groupCount++;
        this.scratchGroupMasks[groupIndex] = childExclusionMask;
        this.scratchGroupMaskLows[groupIndex] = exclusionMaskLow(childExclusionMask);
        this.scratchGroupMaskHighs[groupIndex] = exclusionMaskHigh(childExclusionMask);
        this.scratchGroupWeights[groupIndex] = 0;
        this.scratchGroupAlternativeCounts[groupIndex] = 0;
        this.scratchGroupFirstPackedEnchants[groupIndex] = 0;
        this.scratchGroupFirstEntryIndexes[groupIndex] = SCRATCH_ENTRY_INDEX_NONE;
        this.scratchGroupLastEntryIndexes[groupIndex] = SCRATCH_ENTRY_INDEX_NONE;
        if (collectAlternatives) this.resetScratchAlternativeDetails(groupIndex);
        return groupIndex;
    }

    private addScratchGroupMember(groupIndex: number, entryIndex: number, nextIndexes: Int32Array): void {
        nextIndexes[entryIndex] = SCRATCH_ENTRY_INDEX_NONE;

        const lastEntryIndex = this.scratchGroupLastEntryIndexes[groupIndex] ?? SCRATCH_ENTRY_INDEX_NONE;
        if (lastEntryIndex === SCRATCH_ENTRY_INDEX_NONE) {
            this.scratchGroupFirstEntryIndexes[groupIndex] = entryIndex;
        } else {
            nextIndexes[lastEntryIndex] = entryIndex;
        }
        this.scratchGroupLastEntryIndexes[groupIndex] = entryIndex;
    }

    private getScratchEntryNextIndexes(): Int32Array {
        const required = this.pool.entries.length;
        if (this.scratchEntryNextIndexes.length < required) {
            this.scratchEntryNextIndexes = new Int32Array(required);
        }
        return this.scratchEntryNextIndexes;
    }

    private resetScratchAlternativeDetails(groupIndex: number): void {
        this.scratchGroupPackedEnchants[groupIndex] ??= [];
        this.scratchGroupAlternativeWeights[groupIndex] ??= [];
        this.scratchGroupPackedEnchants[groupIndex]!.length = 0;
        this.scratchGroupAlternativeWeights[groupIndex]!.length = 0;
    }

    private addScratchAlternativeSummary(groupIndex: number, packedEnchant: PackedEnchant): void {
        if ((this.scratchGroupAlternativeCounts[groupIndex] ?? 0) === 0) {
            this.scratchGroupFirstPackedEnchants[groupIndex] = packedEnchant;
        }
        this.scratchGroupAlternativeCounts[groupIndex] = (this.scratchGroupAlternativeCounts[groupIndex] ?? 0) + 1;
        this.groupedAlternativeCount++;
    }

    private addScratchAlternative(
        groupIndex: number,
        packedEnchant: PackedEnchant,
        weight: number,
        countDiscovery = true
    ): void {
        const packedEnchants = this.scratchGroupPackedEnchants[groupIndex]!;
        const weights = this.scratchGroupAlternativeWeights[groupIndex]!;
        for (let index = 0; index < packedEnchants.length; index++) {
            if (packedEnchants[index] !== packedEnchant) continue;
            weights[index] = (weights[index] ?? 0) + weight;
            return;
        }

        packedEnchants.push(packedEnchant);
        weights.push(weight);
        this.collectedAlternativeDetailCount++;
        if (countDiscovery) this.groupedAlternativeCount++;
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
        return this.getOrCreateNodeIdWithParts(
            exclusionMask,
            exclusionMaskLow(exclusionMask),
            exclusionMaskHigh(exclusionMask),
            currentLevel,
            count,
            programId
        );
    }

    private getOrCreateNodeIdWithParts(
        exclusionMask: bigint,
        exclusionMaskLow: number,
        exclusionMaskHigh: number,
        currentLevel: number,
        count: number,
        programId: FlexProgramId
    ): FlexNodeId {
        const stateKey = this.createNodeStateKey(currentLevel, count);
        const identityProgramId = this.getIdentityProgramId(programId);
        const existing = this.nodeIndex.getParts(exclusionMaskLow, exclusionMaskHigh, stateKey, identityProgramId);
        if (existing !== undefined) {
            this.nodeReuseCount++;
            return existing;
        }

        return this.createNodeIdWithParts(
            exclusionMask,
            exclusionMaskLow,
            exclusionMaskHigh,
            currentLevel,
            count,
            programId,
            identityProgramId
        );
    }

    private createNodeIdWithParts(
        exclusionMask: bigint,
        exclusionMaskLow: number,
        exclusionMaskHigh: number,
        currentLevel: number,
        count: number,
        programId: FlexProgramId,
        identityProgramId: FlexProgramId
    ): FlexNodeId {
        const stateKey = this.createNodeStateKey(currentLevel, count);
        const id = this.counts.length as FlexNodeId;
        this.nodeCreateCount++;
        this.exclusionMasks.push(exclusionMask);
        this.currentLevels.push(currentLevel);
        this.counts.push(count);
        this.programIds.push(programId);
        this.debugExpansionCache.push(undefined);
        this.nodeIndex.setParts(exclusionMask, exclusionMaskLow, exclusionMaskHigh, stateKey, identityProgramId, id);
        if (this.programs.hasChoice(programId)) {
            this.plexNodeCount++;
        } else {
            this.solidNodeCount++;
        }
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
        return this.stateIdentityMode === 'reduced' ? REDUCED_IDENTITY_PROGRAM_ID : programId;
    }

    private getTerminalReason(count: number): 'max-enchants' | 'single-book' | null {
        if (this.kernel.item === 'book' && !this.kernel.multiEnchantBooks && count >= FLEX_GRAPH_TRAVERSAL.SINGLE_ENCHANT_BOOK_TERMINAL_COUNT) {
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

function exclusionMaskLow(exclusionMask: bigint): number {
    return Number(exclusionMask & FLEX_HASH_CONFIG.LOW_32_BITS_MASK) >>> 0;
}

function exclusionMaskHigh(exclusionMask: bigint): number {
    return Number((exclusionMask >> FLEX_HASH_CONFIG.HIGH_32_BITS_SHIFT) & FLEX_HASH_CONFIG.LOW_32_BITS_MASK) >>> 0;
}

function getEnchantId(packedEnchant: PackedEnchant): number {
    return packedEnchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
}

function sortEdgeArrays(
    edgeWeights: Uint32Array,
    edgeChildIds: Int32Array,
    edgeCount: number,
    edgeGraphIds?: Int32Array | undefined
): void {
    for (let index = 1; index < edgeCount; index++) {
        const weight = edgeWeights[index]!;
        const childId = edgeChildIds[index]!;
        const graphId = edgeGraphIds?.[index];
        let cursor = index - 1;
        while (
            cursor >= 0
            && (edgeWeights[cursor]! < weight
                || (edgeWeights[cursor] === weight && edgeChildIds[cursor]! > childId))
        ) {
            edgeWeights[cursor + 1] = edgeWeights[cursor]!;
            edgeChildIds[cursor + 1] = edgeChildIds[cursor]!;
            if (edgeGraphIds !== undefined) edgeGraphIds[cursor + 1] = edgeGraphIds[cursor]!;
            cursor--;
        }
        edgeWeights[cursor + 1] = weight;
        edgeChildIds[cursor + 1] = childId;
        if (edgeGraphIds !== undefined) edgeGraphIds[cursor + 1] = graphId ?? SAME_GRAPH_EDGE_ID;
    }
}
