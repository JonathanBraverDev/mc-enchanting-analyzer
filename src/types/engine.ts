import { Enchantment, EnchantmentData } from './domain.js';
import { SearchHeap } from '../utils/collections/SearchHeap.js';
import { LRUCache } from '../utils/collections/LRUCache.js';

import { MassAccounting, MassBookkeeping } from './mass.js';

/**
 * Raw calculation statistics from the search engine.
 */
export interface CalculationStats {
  ranks: { [idAndRank: number]: number }; // (id << 8 | rank)
  any: { [id: number]: number };          // base id
  count: { [count: number]: number };
  combos: { [packed: string]: number };    // Hex string of bit-packed BigInt
  
  /** Simplified Accuracy: Resolved mass. */
  accuracy: number;
  /** Complete diagnostic breakdown of all mass states. */
  accounting: MassAccounting;
  
  instrumentation?: EngineInstrumentation;
  timing?: SearchTiming;
}

export interface CacheStats {
  hits: number;
  misses: number;
}

export interface MassCheckpoint {
  modLevel: number;
  threshold: number;
  mass: number;
  iterations: number;
  totalIterations: number;
}

export interface CheckpointSummary {
  /** The mass target (e.g. 0.5, 0.9, 0.999) */
  target: number;
  /** Minimum threshold needed to reach this target — worst case across all modified levels */
  worstCaseThreshold: number;
  /** Maximum iterations needed to reach this target — worst case across all modified levels */
  worstCaseIterations: number;
  /** The modified level that was the bottleneck */
  bottleneckLevel: number;
}

export interface SearchTiming {
  totalMs: number;
  searchMs: number;
  filteringMs: number;
  distributionMs: number;
  settlingMs: number;
  heapMs: number;
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
  resultsSize?: number;
  /** Current number of nodes in the priority queue */
  queueSize?: number;
  /** Size of the heap's internal deduplication map */
  indexMapSize?: number;
  /** Current heap usage in MB */
  memoryMB?: number;

  /** Total unique results aggregated across all modified levels so far in this specific calculation */
  globalResultsSize?: number;
  /** Total nodes currently stored in ALL frontiers across the entire engine's LRU caches */
  globalCacheNodes?: number;
  /** Total results currently stored in ALL frontiers across the entire engine's LRU caches */
  globalCacheResults?: number;

  /** Raw per-level checkpoints — one entry per modified level x checkpoint target crossed */
  checkpoints: MassCheckpoint[];
  /** Aggregated summary: worst-case threshold and iteration count per mass target across all levels */
  checkpointSummary: CheckpointSummary[];
  exitReason?: EngineExitReason;

  /** Optional: If true, perform expensive global heap scans for cache nodes/results */
  trackGlobalMetrics?: boolean;
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
    eligibleEnchants: Int32Array;
    eligibleWeights: Int32Array;
    nextLevel: number;
    currentCount: number;
    currentCombo: number;
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
    harvester: IResidualMassHarvester;
    results: Map<PackedCombo, bigint>;
    queue: SearchHeap;
    anyMass: BigUint64Array;
    rankMass: BigUint64Array;
    countMass: BigUint64Array;
    resultsLimit: number;
    accountant: any; // Typed as any to avoid circular dependency with MassAccountant
    instrumentation?: EngineInstrumentation;
    timing?: SearchTiming;
    
    // Search-global parameters
    cat: string;
    guaranteedFirstId: number | null;
    pool: PackedEnchant[];
    poolWeights: number[];
    initialTotalWeight: number;
}

/**
 * Interface for the Residual Mass Harvester which handles high-speed forwarding
 * of probability mass for already-expanded nodes.
 */
export interface IResidualMassHarvester {
    registerExpansion(key: bigint, blueprint: ExpansionBlueprint): void;
    has(key: bigint): boolean;
    getCacheSize(): number;
    forwardMass(
        incomingMass: bigint,
        meta: bigint,
        combo: number,
        ctx: ForwardingContext
    ): bigint;
    clone(): IResidualMassHarvester;
}

/**
 * State of a search for enchantment combinations.
 */
export interface SearchFrontier {
    queue: SearchHeap;
    results: Map<PackedCombo, bigint>;
    anyMass: BigUint64Array;
    rankMass: BigUint64Array;
    countMass: BigUint64Array;
    mass: MassBookkeeping;
    threshold: bigint;
    iterations: number;
    nodesProcessed: number;
    harvester: IResidualMassHarvester;
    checkpoints: MassCheckpoint[];  // per-call output; not carried over on resume
    exitReason?: EngineExitReason;  // per-call output; not carried over on resume
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

export type PackedEnchant = number;
export type PackedCombo = number;

/**
 * Public configuration options for a full statistics calculation.
 */
export interface SearchConfig {
    guaranteedFirst?: string | null;
    threshold?: number;
    signal?: AbortSignal;
    onProgress?: (stats: CalculationStats) => void;
    maxIterations?: number;
    summaryLimit?: number;
    resultsLimit?: number;
    useCache?: boolean;
    instrumentation?: EngineInstrumentation;
    timing?: SearchTiming;
}

/**
 * Internal configuration used at the engine→aggregator boundary.
 * Extends SearchConfig with cache accessors that are internal implementation details.
 */
export interface InternalSearchConfig extends SearchConfig {
    getExtendedCache?: (ml: number) => SearchFrontier | undefined;
    setExtendedCache?: (ml: number, frontier: SearchFrontier) => void;
    distCache?: Map<string, { [level: number]: bigint }>;
    poolCache?: LRUCache<string, PackedEnchant[]>;
    instrumentation?: EngineInstrumentation;
    timing?: SearchTiming;
    getCacheMetrics?: () => { cacheNodes: number; cacheResults: number };
}
