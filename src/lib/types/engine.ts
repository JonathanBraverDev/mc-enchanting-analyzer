import { Enchantment, EnchantmentData } from '#types/domain.js';
import { SearchHeap } from '#utils/collections/SearchHeap.js';

import { MassAccounting } from '#types/mass.js';

/**
 * Raw calculation statistics from the search engine.
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
  /** Map of enchantment rank IDs to their total probability of being the shown clue. Key is (enchantId << 8 | rank). */
  clues: { [idAndRank: number]: number };

  /** The minimum probability threshold used for this search. */
  threshold: number;
  /** Normalized resolved mass (0.0 to 1.0). */
  accuracy: number;
  /** Detailed breakdown of where the total 1.0 probability mass settled. */
  accounting: MassAccounting;

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

export interface ExploredMassSample {
  modLevel: number;
  targetMass: number;
  exploredMass: number;
  frontierProbability: number;
  iterations: number;
  totalIterations: number;
}

export interface SearchTiming {
  totalMs: number;
  searchMs: number;
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

export interface MergedItems {
  [category: string]: string[];
}

export interface MergedOverrides {
  [enchantment: string]: Partial<Enchantment>;
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
    eligibleEnchants: PackedEnchant[];
    eligibleWeights: Int32Array;
    nextLevel: number;
    currentCount: number;
    currentCombo: PackedCombo;
    currentEnchants: PackedEnchant[];
    /** Rounding residue accumulated from previous arrivals at this node. */
    residue: bigint;
}

/**
 * Shared context for mass distribution and forwarding operations.
 * Bundles search state to reduce parameter ceremony.
 */
export interface ForwardingContext {
    registry: RegistryState;
    results: Map<PackedCombo, bigint>;
    queue: SearchHeap;
    resultsLimit: number;
    instrumentation?: EngineInstrumentation | undefined;
    timing?: SearchTiming | undefined;

    // Search-global parameters
    cat: string;
    pool: PackedEnchant[];
    poolWeights: number[];
    initialTotalWeight: number;
}


/**
 * State of a search for enchantment combinations.
 */
export interface SearchState {
    queue: SearchHeap;
    results: Map<PackedCombo, bigint>;
    tracker: import('../engine/search/SearchStateTracker.js').SearchStateTracker;
    threshold: bigint;
    iterations: number;
    nodesProcessed: number;
    exitReason?: EngineExitReason | undefined;  // per-call output; not carried over on resume
}

/**
 * Internal state of a Registry, containing pre-computed mapping and conflict data.
 */
export interface RegistryState {
    data: EnchantmentData;
    version: string;
    mechanics: import('./domain.js').VersionMechanics;
    mergedItems: MergedItems;
    mergedOverrides: MergedOverrides;
    resolvedRegistry: ResolvedRegistry;
    mergedMaterials: Set<string>;
    multiEnchantBooks: boolean;
    idMap: Map<string, number>;
    revIdMap: string[];
    catIdMap: Map<string, number>;
    matIdMap: Map<string, number>;
    conflictBitsets: BigUint64Array;
    weightMap: Uint32Array;
    sortedRanks: [string, number][];
    versionPool: Map<string, string[]>;
    enchantToIndex: Map<number, number>;
    indexToEnchant: number[];
}

export type PackedEnchant = number & { __brand: "PackedEnchant" };
export type PackedCombo = number & { __brand: "PackedCombo" };
export type ProbabilityValue = bigint & { __brand: "ProbabilityValue" };

export interface SearchConfig {
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

/**
 * Internal configuration used at the engine→aggregator boundary.
 * Extends SearchConfig with cache accessors that are internal implementation details.
 */
export interface InternalSearchConfig extends SearchConfig {
    getExtendedCache?: ((ml: number) => SearchState | undefined) | undefined;
    setExtendedCache?: ((ml: number, frontier: SearchState) => void) | undefined;
    getCacheMetrics?: (() => { cacheNodes: number; cacheResults: number }) | undefined;
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

/**
 * Raw results from an aggregation run before summarization.
 */
export interface AggregationResult {
    combos: Map<PackedCombo, bigint>;
    tracker: import('../engine/search/SearchStateTracker.js').SearchStateTracker;
    frontiers?: { heap: import('../utils/collections/SearchHeap.js').SearchHeap, scale: bigint }[] | undefined;
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
