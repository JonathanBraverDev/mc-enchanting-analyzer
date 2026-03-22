/**
 * Packed representation of a search node to minimize object and array overhead.
 */
export interface PackedNode {
    packedChosen: bigint;
    meta: bigint; // (bitset << 8 | level)
    prob: bigint;
}

/**
 * Type aliases for clarity in enchantment engine logic.
 * PackedEnchant: (id << 8 | rank)
 * PackedCombo: (count << 60 | slot0 << 0 | slot1 << 12 | ...)
 */
export type PackedEnchant = number;
export type PackedCombo = bigint;

/**
 * Compact representation of calculation statistics for efficient transfer.
 */
export interface CompactStats {
    comboKeys: BigUint64Array;
    comboProbs: Float64Array;
    rankKeys: Uint32Array;
    rankProbs: Float64Array;
    anyKeys: Uint32Array;
    anyProbs: Float64Array;
    counts: Float64Array;
    uncertainty: number;
    pruned?: number;
}

/**
 * Interface for resolving enchantment names from IDs.
 */
export interface NameResolver {
    getFullEnchantName(n: number): string;
    getEnchantName(id: number): string;
}
