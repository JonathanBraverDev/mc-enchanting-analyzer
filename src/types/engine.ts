import { Enchantment, EnchantmentData } from './domain.js';
import { BinaryHeap } from '../utils/collections/BinaryHeap.js';
import { LRUCache } from '../utils/collections/LRUCache.js';

/**
 * Raw calculation statistics from the search engine.
 */
export interface CalculationStats {
  ranks: { [idAndRank: number]: number }; // (id << 8 | rank)
  any: { [id: number]: number };          // base id
  count: { [count: number]: number };
  combos: { [packed: string]: number };    // Hex string of bit-packed BigInt
  uncertainty: number;
  pruned?: number;
  roundingError?: number;
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
 * State of a search for enchantment combinations.
 */
export interface SearchFrontier {
    queue: BinaryHeap<PackedNode>;
    results: Map<PackedCombo, bigint>;
    anyMass: Map<number, bigint>;
    rankMass: Map<number, bigint>;
    countMass: Map<number, bigint>;
    uncertainty: bigint;
    cumulativeAccountedMass: bigint;
    prunedMass: bigint;
    roundingError: bigint;
    threshold: bigint;
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
}
