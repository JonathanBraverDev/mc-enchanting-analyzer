import { PackedEnchant, PackedCombo } from '../../types/index.js';

/**
 * Utility for packing and unpacking enchantment combinations into numbers.
 * Uses a flat lookup table (enchant_id, rank) → byte index for efficient Map key operations.
 * All methods that need lookup tables take them explicitly as parameters.
 */
export class ComboUtils {
    static getEnchantId(packed: PackedEnchant): number { return packed >> 8; }
    static getEnchantRank(packed: PackedEnchant): number { return packed & 0xFF; }

    static readonly BYTE_MULTIPLIERS = [1, 256, 65536, 16777216, 4294967296, 1099511627776];

    static getCount(packed: PackedCombo): number {
        let mult = 1;
        for (let i = 0; i < 6; i++, mult *= 256) {
            if (Math.floor(packed / mult) % 256 === 0) return i;
        }
        return 6;
    }

    /**
     * Packs a set of enchantments into a number.
     * Uses a flat byte-per-slot encoding with a prebuilt lookup table.
     */
    static pack(chosen: PackedEnchant[], enchantToIndex: Map<number, number>): PackedCombo {
        if (chosen.length === 0) return 0 as PackedCombo;

        const indices: number[] = [];
        for (const c of chosen) {
            const idx = enchantToIndex.get(c);
            if (idx !== undefined) indices.push(idx);
        }

        indices.sort((a, b) => b - a);

        let packed = 0;
        let mult = 1;
        for (const v of indices) {
            packed += v * mult;
            mult *= 256;
        }

        return packed as PackedCombo;
    }

    /**
     * Unpacks a number back into numeric enchantment IDs (id << 8 | rank).
     */
    static unpack(packed: PackedCombo, indexToEnchant: number[]): PackedEnchant[] {
        if (Number(packed) === 0) return [];

        const out: PackedEnchant[] = [];
        let mult = 1;
        for (let i = 0; i < 6; i++, mult *= 256) {
            const idx = Math.floor(packed / mult) % 256;
            if (idx === 0) break;
            const enchant = indexToEnchant[idx];
            if (enchant === undefined) break;
            out.push(enchant as PackedEnchant);
        }
        return out;
    }

    /**
     * Appends a single enchant to an already-packed combo without creating an intermediate array.
     * guaranteedInCombo must be true iff the guaranteed enchant is already present in existing.
     * The caller must guarantee that newItem is not already in existing.
     */
    static packAppend(
        existing: PackedCombo,
        newItem: PackedEnchant,
        enchantToIndex: Map<number, number>
    ): PackedCombo {
        const newIdx = enchantToIndex.get(newItem);
        if (newIdx === undefined) return existing;

        const count = this.getCount(existing);

        if (count === 0) {
            return newIdx as PackedCombo;
        }

        // Insert in descending idx order to maintain canonical representation
        let insertPos = count;
        let multScan = 1;
        for (let i = 0; i < count; i++, multScan *= 256) {
            const b = Math.floor(existing / multScan) % 256;
            if (newIdx > b) {
                insertPos = i;
                break;
            }
        }

        let packed = 0;
        let mult = 1;
        for (let i = 0; i < insertPos; i++, mult *= 256) {
            const b = Math.floor(existing / mult) % 256;
            packed += b * mult;
        }
        packed += newIdx * mult;
        for (let i = insertPos; i < count; i++, mult *= 256) {
            const b = Math.floor(existing / mult) % 256;
            packed += b * (mult * 256);
        }
        return packed as PackedCombo;
    }

    /**
     * For books: returns all possible combinations after removing one "selected at random" enchantment.
     * Based on Minecraft Wiki: "If multiple enchantments were generated, then one selected at random is removed."
     *
     * OPTIMIZED BITWISE VERSION: Avoids unpack/sort/pack cycle and array allocations.
     */
    static removeAdditional(packed: PackedCombo): PackedCombo[] {
        const count = this.getCount(packed);
        if (count <= 1) return [packed];

        const possibleResults: PackedCombo[] = [];
        let mult = 1;
        for (let i = 0; i < count; i++, mult *= 256) {
            const byteVal = Math.floor(packed / mult) % 256;
            if (byteVal === 0) continue;

            // Mathematically remove the i-th byte by zeroing it and shifting the upper bytes down
            const lowerPart = packed % mult;
            const nextPacked = (i + 1 < count)
                ? lowerPart + (Math.floor(packed / (mult * 256)) * mult)
                : lowerPart;
            
            possibleResults.push(nextPacked as PackedCombo);
        }

        return possibleResults;
    }
}
