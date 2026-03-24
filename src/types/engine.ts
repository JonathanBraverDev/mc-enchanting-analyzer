import { Enchantment } from './domain.js';

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
}

/**
 * Human-readable enchantment calculation statistics.
 */
export interface EnchantInsights {
    ranks: Record<string, number>;
    any: Record<string, number>;
    count: Record<number, number>;
    combos: Record<string, number>;
    uncertainty: number;
    pruned?: number;
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

export interface NameResolver {
    getFullEnchantName(n: number): string;
    getEnchantName(id: number): string;
}

/**
 * Packed representation of a search node to minimize object and array overhead.
 */
export interface PackedNode {
    packedChosen: bigint;
    meta: bigint; // (bitset << 8 | level)
    prob: bigint;
}


/**
 * Internal state of a Registry, containing pre-computed mapping and conflict data.
 */
export interface RegistryState {
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
}

export type PackedEnchant = number;
export type PackedCombo = bigint;
