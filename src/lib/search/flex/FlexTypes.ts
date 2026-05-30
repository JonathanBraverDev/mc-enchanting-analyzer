import type { EngineExitReason, PackedEnchant } from '#types/index.js';
import type { MassAccountingBreakdown, MassAccountingDetails } from '#types/mass.js';
import type { PendingFrontierAggregates } from '#lib/search/SearchSnapshot.js';

export type FlexNodeId = number & { readonly __brand: 'FlexNodeId' };
export type FlexProgramId = number & { readonly __brand: 'FlexProgramId' };
export type FlexStateIdentityMode = 'reduced' | 'program';

export interface FlexAlternative {
    readonly packedEnchant: PackedEnchant;
    readonly weight: number;
}

export interface FlexRankAlternative {
    readonly enchantId: number;
    readonly weight: number;
}

export interface FlexFixedEmission {
    readonly kind: 'fixed';
    readonly packedEnchant: PackedEnchant;
}

export interface FlexRankFixedEmission {
    readonly kind: 'rank-fixed';
    readonly profileId: number;
    readonly enchantId: number;
}

export interface FlexChoiceEmission {
    readonly kind: 'choice';
    readonly alternatives: readonly FlexAlternative[];
    readonly totalWeight: number;
}

export interface FlexRankChoiceEmission {
    readonly kind: 'rank-choice';
    readonly profileId: number;
    readonly alternatives: readonly FlexRankAlternative[];
    readonly totalWeight: number;
}

export type FlexEmission = FlexFixedEmission | FlexChoiceEmission | FlexRankFixedEmission | FlexRankChoiceEmission;
export type FlexProgram = readonly FlexEmission[];

export type FlexRankProfileResolver = (profileId: number, enchantId: number) => PackedEnchant | undefined;

export interface FlexNodeBase {
    readonly id: FlexNodeId;
    readonly programId: FlexProgramId;
    readonly count: number;
}

export interface SolidNode extends FlexNodeBase {
    readonly kind: 'solid';
}

export interface PlexNode extends FlexNodeBase {
    readonly kind: 'plex';
}

export type FlexNode = SolidNode | PlexNode;

export interface FlexEdge {
    readonly weight: number;
    readonly childId: FlexNodeId;
}

export type FlexTerminalReason = 'overflow' | null;

export interface FlexSearchExpansion {
    readonly nodeId: FlexNodeId;
    readonly programId: FlexProgramId;
    readonly nodeKind: FlexNode['kind'];
    readonly count: number;
    readonly probContinue: bigint;
    readonly totalWeight: number;
    readonly edgeCount: number;
    readonly edgeWeights: ArrayLike<number>;
    readonly edgeChildIds: ArrayLike<number>;
    readonly clueIncompatibleWeight?: number | undefined;
    readonly terminalReason: FlexTerminalReason;
}

export type FlexSearchExpansionConsumer<T> = (expansion: FlexSearchExpansion) => T;

export interface FlexExpansion {
    readonly node: FlexNode;
    readonly probContinue: bigint;
    readonly totalWeight: number;
    readonly edges: readonly FlexEdge[];
    readonly clueIncompatibleWeight?: number | undefined;
    readonly terminalReason: FlexTerminalReason;
}

export interface FlexGraph {
    getExpansion(nodeId: FlexNodeId): FlexExpansion;
    withSearchExpansion<T>(nodeId: FlexNodeId, consumer: FlexSearchExpansionConsumer<T>): T;
    getProgramId(nodeId: FlexNodeId): FlexProgramId;
    getNodeCount(nodeId: FlexNodeId): number;
    getNodeKind(nodeId: FlexNodeId): FlexNode['kind'];
    getNode(nodeId: FlexNodeId): FlexNode;
}

export interface FlexGraphMemoryStats {
    readonly nodeCount: number;
    readonly solidNodeCount: number;
    readonly plexNodeCount: number;
    readonly searchExpansionCount: number;
    readonly debugExpansionCount: number;
    readonly shapeCacheHitCount: number;
    readonly shapeCacheMissCount: number;
    readonly directExpansionBuildCount: number;
    readonly shapedExpansionBuildCount: number;
    readonly groupingBuildCount: number;
    readonly groupedEdgeCount: number;
    readonly groupedAlternativeCount: number;
    readonly collectedAlternativeDetailCount: number;
    readonly singletonGroupCount: number;
    readonly choiceGroupCount: number;
    readonly nodeCreateCount: number;
    readonly nodeReuseCount: number;
    readonly preparedFixedEmissionCount: number;
    readonly preparedChoiceEmissionCount: number;
    readonly preparedChoiceAlternativeCount: number;
    readonly lazyChoiceEmissionScanCount: number;
    readonly lazyChoiceEmissionMemberVisitCount: number;
    readonly shapePreparedEmissionAppendCount: number;
    readonly nodeIndexGrowCount: number;
}

export interface FlexCoordinatorMemoryStats {
    readonly frontierGrowCount: number;
    readonly frontierIndexGrowCount: number;
    readonly residueArrayAllocationCount: number;
    readonly activeResidueRecordCount: number;
    readonly expandedSolidNodeCount: number;
    readonly expandedPlexNodeCount: number;
}

export interface FlexProgramStoreMemoryStats {
    readonly programCount: number;
    readonly cachedProgramCount: number;
}

export interface FlexRunMemoryStats {
    readonly coordinator: FlexCoordinatorMemoryStats;
    readonly programs: FlexProgramStoreMemoryStats;
    readonly graphs: readonly FlexGraphMemoryStats[];
}

export interface FlexCheckpointRequest {
    readonly threshold?: number | bigint | undefined;
    readonly maxIterations?: number | undefined;
    readonly drainEqualMassBand?: boolean | undefined;
    readonly exhaustive?: boolean | undefined;
    readonly targetClassifiedMass?: number | bigint | undefined;
    /**
     * Internal forward-mass floor. Omit to use Flex's default system floor for bounded searches;
     * set to 0 for legacy parity diagnostics that must not sieve tail nodes early.
     */
    readonly probabilityFloor?: number | bigint | undefined;
    readonly signal?: AbortSignal | undefined;
    /** Async search yield cadence. Used by worker-facing execution so abort messages can be observed. */
    readonly yieldEveryIterations?: number | undefined;
}

export interface FlexPendingEntry {
    readonly graphId: number;
    readonly nodeId: FlexNodeId;
    readonly programId: FlexProgramId;
    readonly mass: bigint;
    readonly count: number;
    readonly nodeKind: FlexNode['kind'];
    readonly targetClueReachable?: boolean | undefined;
}

export type FlexPendingEntryVisitor = (
    graphId: number,
    nodeId: FlexNodeId,
    programId: FlexProgramId,
    mass: bigint,
    count: number,
    nodeKind: FlexNode['kind']
) => void;

export interface FlexRunState {
    readonly results: ReadonlyMap<FlexProgramId, bigint>;
    readonly mass: MassAccountingBreakdown;
    readonly massDetails?: MassAccountingDetails | undefined;
    readonly iterations: number;
    readonly lastExpandedMass: bigint;
    readonly pendingCount: number;
    readonly largestPendingMass: bigint;
    readonly graphCount: number;
    readonly activeResidueCount: number;
    readonly activeResidueMass: bigint;
    readonly fullyResolved: boolean;
    readonly exitReason: EngineExitReason | undefined;
}

export interface FlexRunSnapshot extends FlexRunState {
    readonly pendingEntries: readonly FlexPendingEntry[];
}

export interface FlexProjectedPendingAggregateResults {
    readonly pendingAggregates: PendingFrontierAggregates;
    readonly projectionLoss: bigint;
    readonly clueIncompatible: bigint;
    readonly projectedMass: bigint;
    readonly sourceMass: bigint;
}
