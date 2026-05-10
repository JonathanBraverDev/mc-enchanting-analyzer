import { Enchantment, MaterialValues, RegistryMutation, RomanMap } from '#types/domain.js';
import { NodeIdSearchFrontier } from '#engine/search/NodeIdSearchFrontier.js';
import { SearchPoolPlan } from '#engine/search/SearchPoolPlan.js';
import { SearchNodeGraph } from '#engine/search/SearchNodeGraph.js';
import type { ClueSearchPolicy } from '#engine/search/ClueSearchPolicy.js';

import { MassAccountingBreakdown } from '#types/mass.js';

/**
 * Presented calculation statistics from the search engine.
 */
export interface CalculationStats {
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
  statsSize: number;
  poolSize: number;
}

export interface SearchCheckpoint {
  threshold: number;
  limit: number;
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

export interface EngineInstrumentation {
  poolCache: CacheStats;
  distCache: CacheStats;
  frontierCache: CacheStats;
  totalIterations: number;
  totalPrunedNodes: number;
  roundingErrorEvents: number;
  levelsProcessed: number;
  levelsFullyResolved: number;
  /** True when every modified level exited with an empty queue — no threshold tuning can improve results */
  fullyResolved: boolean;

  /** Total entries in the combinations results map */
  resultsSize?: number | undefined;
  /** Current number of nodes in the priority queue */
  queueSize?: number | undefined;
  /** Size of the heap's internal deduplication map */
  indexMapSize?: number | undefined;
  /** Current heap usage in MB */
  memoryMB?: number | undefined;

  /** Total unique results aggregated across all modified levels so far in this specific calculation */
  globalResultsSize?: number | undefined;
  /** Total nodes currently stored in ALL frontiers across the entire engine's LRU caches */
  globalCacheNodes?: number | undefined;
  /** Total results currently stored in ALL frontiers across the entire engine's LRU caches */
  globalCacheResults?: number | undefined;

  /** Optional script/diagnostic targets for recording explored mass crossings. */
  exploredMassTargets?: number[] | undefined;
  /** Diagnostic samples recorded when explored mass crosses configured targets. */
  exploredMassSamples?: ExploredMassSample[] | undefined;

  exitReason?: EngineExitReason | undefined;

  /** Optional: If true, perform expensive global heap scans for cache nodes/results */
  trackGlobalMetrics?: boolean | undefined;
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
 * Shared context for mass distribution and forwarding operations.
 * Bundles search state to reduce parameter ceremony.
 */
export interface ForwardingContext {
    registry: RegistryState;
    results: Map<PackedCombo, bigint>;
    queue: NodeIdSearchFrontier;
    graph: SearchNodeGraph;
    resultsLimit: number;
    instrumentation?: EngineInstrumentation | undefined;
    timing?: SearchTiming | undefined;

    // Search-global parameters
    item: string;
    poolPlan: SearchPoolPlan;
    cluePolicy?: ClueSearchPolicy | undefined;
}


/**
 * State of a search for enchantment combinations.
 */
export interface SearchState {
    queue: NodeIdSearchFrontier;
    graph: SearchNodeGraph;
    results: Map<PackedCombo, bigint>;
    tracker: import('../engine/search/SearchStateTracker.js').SearchStateTracker;
    threshold: bigint;
    iterations: number;
    nodesProcessed: number;
    exitReason?: EngineExitReason | undefined;  // per-call output; not carried over on resume
}

export interface SearchFrontierSnapshot {
    frontier: NodeIdSearchFrontier;
    graph: SearchNodeGraph;
    scale: bigint;
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
    enchantToIndex: Map<number, number>;
    indexToEnchant: number[];
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
    /** Explicit engine implementation selector. Defaults to the legacy V6 engine until V7 is fully integrated. */
    engine?: 'v6' | 'v7' | undefined;
    /** The observed enchantment clue (e.g. "Sharpness IV"). Trigger Bayesian conditioning if set. */
    clue?: string | null | undefined;
    threshold?: number | bigint | undefined;
    signal?: AbortSignal | undefined;
    onProgress?: ((update: ProgressUpdate) => void) | undefined;
    maxIterations?: number | undefined;
    summaryLimit?: number | undefined;
    resultsLimit?: number | undefined;
    useCache?: boolean | undefined;
    instrumentation?: EngineInstrumentation | undefined;
    timing?: SearchTiming | undefined;
}

export interface ItemSelectionRequest {
    item: string;
    material: string;
}

export type CalculationRequest = SearchConfig & ItemSelectionRequest & {
    xp: number;
};

export type ModifiedLevelSearchRequest = ItemSelectionRequest & {
    modLevel: number;
    threshold?: bigint | undefined;
    maxIterations?: number | undefined;
    resultsLimit?: number | undefined;
    instrumentation?: EngineInstrumentation | undefined;
};

export type CheckpointSearchRequest = SearchConfig & ItemSelectionRequest & {
    xp: number;
};

export type SequentialCheckpointSearchRequest = SearchConfig & ItemSelectionRequest & {
    xp: number;
    checkpoints: SearchCheckpoint[];
    onCheckpointComplete: (result: SearchResult, checkpointIndex: number) => void;
};

export interface SummaryRequest {
    combos: Map<PackedCombo, bigint>;
    tracker: import('../engine/search/SearchStateTracker.js').SearchStateTracker;
    indexToEnchant: number[];
    comboLimit?: number | undefined;
    threshold?: number | undefined;
    frontiers?: SearchFrontierSnapshot[] | undefined;
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
    combos: Map<PackedCombo, bigint>;
    tracker: import('../engine/search/SearchStateTracker.js').SearchStateTracker;
    frontiers?: SearchFrontierSnapshot[] | undefined;
    instrumentation?: EngineInstrumentation | undefined;
    timing?: SearchTiming | undefined;
    threshold: number;
}

/**
 * Context for the Best-First search algorithm tracking.
 * Used internally by the SearchController and SearchService.
 */
export interface SearchContext {
    threshold: bigint;
    limit: number;
    resultsLimit: number;
    signal?: AbortSignal | undefined;
    instrumentation?: EngineInstrumentation | undefined;
    timing?: SearchTiming | undefined;
}

export interface ModifiedLevelSearchContext extends SearchContext {
    registry: RegistryState;
    item: string;
    modLevel: number;
    material?: string | undefined;
    existingState?: SearchState | undefined;
    useCache?: boolean | undefined;
    targetClueId?: number | undefined;
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
