import { Enchantment, MaterialValues, RegistryMutation, RomanMap } from '#types/domain.js';
import type { SearchRunSnapshot } from '#lib/search/SearchRun.js';

import { MassAccountingBreakdown } from '#types/mass.js';

/**
 * Presented enchant stats from the search engine.
 */
export interface EnchantStats {
  /** Map of enchantment rank IDs to their total cumulative probability. Key is (enchantId << 8 | rank). */
  ranks: { [idAndRank: number]: number };
  /** Map of base enchantment IDs to their total probability on the item (any rank). */
  any: { [id: number]: number };
  /** Map of enchantment counts (1, 2, 3...) to their total probability. */
  count: { [count: number]: number };
  /** Map of bit-packed hexadecimal combo strings to their joint probability. */
  combos: { [packed: string]: number };
  /** Map of enchantment rank IDs to their total probability of being the shown table clue. Omitted for clue-conditioned stats. */
  shownClueDistribution?: { [idAndRank: number]: number } | undefined;
  /** The minimum probability threshold used for this search. */
  threshold: number;
  /** Normalized classified mass (resolved results plus exact clue-incompatible mass). */
  accuracy: number;
  /** Detailed breakdown of where the total 1.0 probability mass settled. */
  accounting: MassAccountingBreakdown;
  /** Observed displayed-clue diagnostics. Present only for clue-conditioned stats. */
  clue?: {
    /** Observed clue enchantment/rank ID, encoded as (enchantId << 8 | rank). */
    idAndRank: number;
    /** Absolute displayed-clue mass used for Bayesian conditioning. */
    knownSpace: number;
  } | undefined;

  instrumentation?: EngineInstrumentation | undefined;
  timing?: SearchTiming | undefined;
}

export type LevelDistribution = { [level: number]: bigint };

export interface CacheStats {
  hits: number;
  misses: number;
}

export interface CacheConfig {
  comboOtherSize: number;
  comboBookSize: number;
  poolSize: number;
}

export interface SearchCheckpoint {
  /** Stop when the largest pending node mass falls below this value. Use 0 to disable the threshold stop. */
  threshold: number;
  /** Maximum graph-node expansions for this checkpoint. */
  limit: number;
  /** Optional classified-mass target for this checkpoint. Search may still stop earlier on threshold/limit. */
  targetClassifiedMass?: number | bigint | undefined;
}

export interface ExploredMassSample {
  modLevel: number;
  targetMass: number;
  exploredMass: number;
  frontierProbability: number;
  iterations: number;
  totalIterations: number;
}

export interface SearchTiming {
  /** Reported engine time, including search and post-processing phases. */
  totalMs: number;
  /** Time spent in the active best-first search loop. */
  searchMs: number;
  /** Time spent converting raw search results into public stats. */
  postProcessingMs?: number | undefined;
}

export type EngineExitReason = 'threshold' | 'iterations' | 'mass' | 'aborted' | 'empty' | 'exhausted';

/** Internal search implementation selector. Defaults to the concrete V7 SearchRun path. */
export type SearchBackend = 'concrete' | 'plex' | 'flex';

export interface EngineInstrumentation {
  /** Eligible-pool registry cache metrics. */
  poolCache: CacheStats;
  /** Modified-level distribution cache metrics. */
  distCache: CacheStats;
  totalIterations: number;
  totalPrunedNodes: number;
  roundingErrorEvents: number;
  levelsProcessed: number;
  levelsFullyResolved: number;
  /** True when every modified level exited with an empty queue — no threshold tuning can improve results */
  fullyResolved: boolean;

  /** Total entries in the combinations results map */
  resultsSize?: number | undefined;
  /** Current number of pending weighted graph nodes in the frontier heap. */
  queueSize?: number | undefined;
  /** Current heap usage in MB */
  memoryMB?: number | undefined;

  /** Total unique results aggregated across all modified levels so far in this specific calculation */
  globalResultsSize?: number | undefined;
  /** Total nodes currently stored in engine-wide cached pending search state */
  globalCacheNodes?: number | undefined;
  /** Total results currently stored in engine-wide cached search state */
  globalCacheResults?: number | undefined;

  /** Optional script/diagnostic targets for recording explored mass crossings. */
  exploredMassTargets?: number[] | undefined;
  /** Diagnostic samples recorded when explored mass crosses configured targets. */
  exploredMassSamples?: ExploredMassSample[] | undefined;

  exitReason?: EngineExitReason | undefined;

  /** Optional: If true, perform expensive global heap scans for cache nodes/results */
  trackGlobalMetrics?: boolean | undefined;

  /** Shared search diagnostics. Present when the engine records them. */
  search?: SearchInstrumentation | undefined;
}

export interface SearchInstrumentation {
  /** Search implementation that produced this checkpoint. */
  backend?: SearchBackend | undefined;
  /** Number of structural search graphs currently used by the run. */
  graphCount: number;
  /** Number of modified levels seeded into the run. */
  seededLevelCount: number;
  /** Number of distinct `(graph, node)` entries still pending in the global frontier. */
  pendingEntryCount: number;
  /** Largest pending frontier mass as a normalized probability. */
  largestPendingMass: number;
  /** Most recent expanded frontier-node mass as a normalized probability. */
  lastExpandedMass: number;
  /** Active node-local split-residue buckets with non-zero mass. */
  activeResidueCount: number;
  /** Total active node-local split residue as a normalized probability. */
  activeResidueMass: number;
  /** Whether this snapshot can still improve under a lower threshold or higher iteration cap. */
  canImprove: boolean;
  /** Cumulative structural SearchGraph cache hits for this engine instance. */
  graphCacheHits?: number | undefined;
  /** Cumulative structural SearchGraph cache misses for this engine instance. */
  graphCacheMisses?: number | undefined;
  /** Cumulative resumable SearchRun cache hits for this engine instance. */
  runCacheHits?: number | undefined;
  /** Cumulative resumable SearchRun cache misses for this engine instance. */
  runCacheMisses?: number | undefined;
  /** Whether run-local suffix canonicalization was enabled for this snapshot. */
  suffixMergingEnabled?: boolean | undefined;
  /** Number of canonical suffix entries recorded by this run. */
  suffixMergeCanonicalEntryCount?: number | undefined;
  /** Number of pending arrivals redirected to an equivalent canonical suffix node. */
  suffixMergeHits?: number | undefined;
  /** Number of suffix identities first registered as canonical nodes. */
  suffixMergeMisses?: number | undefined;
  /** Probability mass redirected to canonical suffix nodes. */
  suffixMergedPendingMass?: number | undefined;
  /** Estimated number of pending entries avoided by suffix canonicalization. */
  suffixAvoidedPendingEntries?: number | undefined;
  /** Plex-only: structural pending buckets before compatibility projection expands payload factors. */
  plexStructuralPendingEntryCount?: number | undefined;
  /** Plex-only: concrete-view materialization loss recorded as compatibility rounding in public accounting. */
  plexProjectionLoss?: number | undefined;
  /** Plex-only: projection-stage mass classified as incompatible with the requested clue. */
  plexProjectionClueIncompatible?: number | undefined;
  /** Flex-only: structural state identity mode used by this run. */
  flexStateIdentityMode?: 'reduced' | 'program' | undefined;
  /** Flex-only: structural pending buckets before compatibility projection expands program factors. */
  flexStructuralPendingEntryCount?: number | undefined;
  /** Flex-only: concrete-view materialization loss recorded as compatibility rounding in public accounting. */
  flexProjectionLoss?: number | undefined;
  /** Flex-only: projection-stage mass classified as incompatible with the requested clue. */
  flexProjectionClueIncompatible?: number | undefined;
}

export interface ResolvedRegistry {
  [enchantment: string]: Enchantment;
}

export interface ItemPools {
  [item: string]: string[];
}

export interface MergedOverrides {
  [enchantment: string]: Partial<Enchantment>;
}

export interface ItemMaterials {
  [item: string]: string[];
}

export interface ItemEnchantabilityTables {
  [item: string]: import('./domain.js').EnchantabilityTable;
}

/**
 * Packed representation of a search node to minimize object and array overhead.
 */
export interface PackedNode {
    packedChosen: number;
    meta: bigint; // (bitset << 8 | level)
    prob: bigint;
}

/**
 * Blueprint caching for already-expanded nodes.
 */
export interface ExpansionBlueprint {
    probContinue: bigint;
    totalWeight: number;
    eligibleCount: number;
    edgeStart: number;
    currentCount: number;
    currentCombo: PackedCombo;
}

/**
 * Internal state of a Registry, containing pre-computed mapping and conflict data.
 */
export interface RegistryState {
    version: string;
    mechanics: import('./domain.js').VersionMechanics;
    romanMap: RomanMap;
    materialPriority: string[];
    materialValues: MaterialValues;
    itemPool: ItemPools;
    mergedOverrides: MergedOverrides;
    resolvedRegistry: ResolvedRegistry;
    mergedMaterials: Set<string>;
    itemMaterials: ItemMaterials;
    itemEnchantability: ItemEnchantabilityTables;
    multiEnchantBooks: boolean;
    idMap: Map<string, number>;
    revIdMap: string[];
    itemIdMap: Map<string, number>;
    materialIdMap: Map<string, number>;
    conflictBitsets: BigUint64Array;
    weightMap: Uint32Array;
    sortedRanks: [string, number][];
    effectiveRankIntervals: { [enchantment: string]: EffectiveRankInterval[] };
    enchantToIndex: Map<number, number>;
    indexToEnchant: number[];
}

/** Runtime rank interval after invalid declared ranges are dropped and higher ranks shadow lower ranks. */
export interface EffectiveRankInterval {
    min: number;
    max: number;
    rank: number;
    rankName: string;
    packedEnchant: PackedEnchant;
}

export interface VanillaRegistryState extends RegistryState {
    readonly source: 'vanilla';
}

export interface MutatedRegistryState extends RegistryState {
    readonly source: 'mutated';
    readonly mutations: readonly RegistryMutation[];
}

export type BuiltRegistryState = VanillaRegistryState | MutatedRegistryState;

export type PackedEnchant = number & { __brand: "PackedEnchant" };
export type PackedCombo = number & { __brand: "PackedCombo" };
export type ProbabilityValue = bigint & { __brand: "ProbabilityValue" };

export interface SearchConfig {
    /** The observed enchantment clue (e.g. "Sharpness IV"). Trigger Bayesian conditioning if set. */
    clue?: string | null | undefined;
    /**
     * Search-detail stop: stop when the largest pending node mass falls below this value.
     * At least one of `threshold`, `maxIterations`, or `targetClassifiedMass` is required unless
     * `exhaustive: true` is set. Supplying two or more stop conditions is recommended for
     * user-facing/product flows so searches have both a quality target and a safety bound.
     */
    threshold?: number | bigint | undefined;
    /**
     * Classified-mass stop: stop once non-pending mass reaches this value. When omitted, no
     * classified-mass stop is installed. A mass target by itself is valid for diagnostics/snapshots
     * that know the desired completion target; add `maxIterations` too when a work budget matters.
     */
    targetClassifiedMass?: number | bigint | undefined;
    /**
     * Internal/experimental forward-mass floor. Omit to use each backend's default; set to 0
     * for parity diagnostics that compare Flex against concrete V7 without early tail sieving.
     */
    probabilityFloor?: number | bigint | undefined;
    signal?: AbortSignal | undefined;
    onProgress?: ((update: ProgressUpdate) => void) | undefined;
    /**
     * Work-budget stop: maximum graph-node expansions to perform before returning a checkpoint.
     * This is a safety/work cap, not a quality target. Lower caps usually return sooner all else
     * equal, and iterations are the most direct work-budget metric, but no search control is a
     * linear runtime proxy. Prefer pairing it with `threshold` or `targetClassifiedMass` for
     * meaningful results.
     */
    maxIterations?: number | undefined;
    /**
     * Opt-in diagnostics/parity mode for iteration-capped checkpoints: after the iteration cap is
     * reached, continue expanding any frontier entries whose mass is at least the last expanded
     * mass. This avoids stopping midway through a same-mass frontier band when comparing backends
     * with different tie-breakers. It is intentionally off by default because it can exceed the
     * requested work cap.
     */
    drainEqualMassBand?: boolean | undefined;
    /**
     * Explicit full-search escape hatch: ignore threshold, iteration cap, and classified-mass target,
     * searching until the frontier is empty, aborted, or host resources are exhausted.
     * This can be extremely expensive on modern book searches; keep product flows on checkpoint limits.
     */
    exhaustive?: boolean | undefined;
    /**
     * Maximum number of combo entries to include in summarized presentation output.
     * Does not limit search work. Values above the normal export cap require `uncappedResults: true`.
     */
    summaryLimit?: number | undefined;
    /** Explicitly allow summarized presentation output to include every combo result. Does not affect search work. */
    uncappedResults?: boolean | undefined;
    useCache?: boolean | undefined;
    instrumentation?: EngineInstrumentation | undefined;
    timing?: SearchTiming | undefined;
    /**
     * Internal/experimental search implementation selector.
     * Omit for the supported/default concrete V7 SearchRun path. Use `plex` or `flex` only
     * for diagnostics, parity checks, and staged engine-internal migration work.
     */
    searchBackend?: SearchBackend | undefined;
}

export interface ItemSelectionRequest {
    item: string;
    material: string;
}

export type CheckpointSearchRequest = SearchConfig & ItemSelectionRequest & {
    xp: number;
};

export type SequentialCheckpointSearchRequest = SearchConfig & ItemSelectionRequest & {
    xp: number;
    checkpoints: SearchCheckpoint[];
    onCheckpointComplete: (result: SearchResult, checkpointIndex: number) => void;
};

export interface SummaryRequest {
    combos: ReadonlyMap<PackedCombo, bigint>;
    snapshot: SearchRunSnapshot;
    indexToEnchant: number[];
    /** Maximum combo entries to include. Values above the normal export cap require `uncappedResults: true`. */
    comboLimit?: number | undefined;
    /** Explicitly allow every combo entry in presentation output. */
    uncappedResults?: boolean | undefined;
    threshold?: number | undefined;
    isBook?: boolean | undefined;
}

export interface ConditionedSummaryRequest extends SummaryRequest {
    targetClueId: number;
}

/**
 * Lightweight progress update from the engine.
 */
export interface ProgressUpdate {
  /** Number of modified levels or units processed. */
  processed: number;
  /** Total number of modified levels or units to process. */
  total: number;
  /** Optional current accuracy (resolved mass). */
  accuracy?: number | undefined;
}

/**
 * Interface for reporting search progress to external consumers.
 */
export interface ProgressReporter {
  onProgress(update: ProgressUpdate): void;
}

/** Search results before presentation summarization. */
export interface SearchResult {
    snapshot: SearchRunSnapshot;
    combos: ReadonlyMap<PackedCombo, bigint>;
    instrumentation?: EngineInstrumentation | undefined;
    timing?: SearchTiming | undefined;
    threshold: number;
}

export interface CheckpointSearchContext extends SearchConfig {
    registry: RegistryState;
    item: string;
    xp: number;
    material: string;
    targetClueId?: number | undefined;
}

export interface SequentialCheckpointSearchContext extends CheckpointSearchContext {
    checkpoints: SearchCheckpoint[];
    onCheckpointComplete: (result: SearchResult, checkpointIndex: number) => void;
}
