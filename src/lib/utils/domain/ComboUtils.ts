import { PACKING_CONSTANTS } from '#constants/engine.js';
import { PackedEnchant, PackedCombo } from '#types/index.js';

/**
 * Utility for packing and unpacking enchantment combinations into numbers.
 * Uses a flat lookup table (enchant_id, rank) → byte index for efficient Map key operations.
 * All methods that need lookup tables take them explicitly as parameters.
 */
export class ComboUtils {
    static getEnchantId(packed: PackedEnchant): number { return packed >> PACKING_CONSTANTS.ENCHANT_SHIFT; }
    static getEnchantRank(packed: PackedEnchant): number { return packed & PACKING_CONSTANTS.RANK_MASK; }

    static readonly BYTE_MULTIPLIERS = Array.from({ length: PACKING_CONSTANTS.MAX_COMBO_SLOTS }, (_, i) => PACKING_CONSTANTS.BYTE_BASIS ** i);

    static getCount(packed: PackedCombo): number {
        let mult = 1;
        for (let i = 0; i < PACKING_CONSTANTS.MAX_COMBO_SLOTS; i++, mult *= PACKING_CONSTANTS.BYTE_BASIS) {
            if (Math.floor(packed / mult) % PACKING_CONSTANTS.BYTE_BASIS === 0) return i;
        }
        return PACKING_CONSTANTS.MAX_COMBO_SLOTS;
    }

    /**
     * Packs a set of enchantments into a number.
     * Uses a flat byte-per-slot encoding with a prebuilt lookup table.
     */
    static pack(chosen: PackedEnchant[], guaranteedFirstId: number | null, enchantToIndex: Map<number, number>): PackedCombo {
        if (chosen.length === 0) return 0 as PackedCombo;

        let firstPicked: number | null = null;
        const others: number[] = [];

        for (const c of chosen) {
            const id = c >> PACKING_CONSTANTS.ENCHANT_SHIFT;
            const idx = enchantToIndex.get(c);
            if (idx === undefined) continue;

            if (guaranteedFirstId !== null && id === guaranteedFirstId && firstPicked === null) {
                firstPicked = idx;
            } else {
                others.push(idx);
            }
        }

        others.sort((a, b) => b - a);
        if (firstPicked !== null) others.unshift(firstPicked);

        let packed = 0;
        let mult = 1;
        for (const v of others) {
            packed += v * mult;
            mult *= PACKING_CONSTANTS.BYTE_BASIS;
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
        for (let i = 0; i < PACKING_CONSTANTS.MAX_COMBO_SLOTS; i++, mult *= PACKING_CONSTANTS.BYTE_BASIS) {
            const idx = Math.floor(packed / mult) % PACKING_CONSTANTS.BYTE_BASIS;
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
        guaranteedFirstId: number | null,
        guaranteedInCombo: boolean,
        enchantToIndex: Map<number, number>
    ): PackedCombo {
        const newIdx = enchantToIndex.get(newItem);
        if (newIdx === undefined) return existing;

        const count = this.getCount(existing);
        const newId = newItem >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        const isNewGuaranteed = guaranteedFirstId !== null && newId === guaranteedFirstId;

        if (count === 0) {
            return newIdx as PackedCombo; 
        }

        if (isNewGuaranteed) {
            // Guaranteed enchant goes to position 0; shift all existing bytes right
            let packed = newIdx;
            let mult = 1;
            for (let i = 0; i < count; i++, mult *= PACKING_CONSTANTS.BYTE_BASIS) {
                const b = Math.floor(existing / mult) % PACKING_CONSTANTS.BYTE_BASIS;
                packed += b * (mult * PACKING_CONSTANTS.BYTE_BASIS);
            }
            return packed as PackedCombo;
        }

        // Non-guaranteed: insert in descending idx order, after guaranteed slot if present
        const sortStart = (guaranteedFirstId !== null && guaranteedInCombo) ? 1 : 0;

        let insertPos = count;
        let multScan = PACKING_CONSTANTS.BYTE_BASIS ** sortStart;
        for (let i = sortStart; i < count; i++, multScan *= PACKING_CONSTANTS.BYTE_BASIS) {
            const b = Math.floor(existing / multScan) % PACKING_CONSTANTS.BYTE_BASIS;
            if (newIdx > b) {
                insertPos = i;
                break;
            }
        }

        let packed = 0;
        let mult = 1;
        for (let i = 0; i < insertPos; i++, mult *= PACKING_CONSTANTS.BYTE_BASIS) {
            const b = Math.floor(existing / mult) % PACKING_CONSTANTS.BYTE_BASIS;
            packed += b * mult;
        }
        // mult is now BYTE_BASIS^insertPos
        packed += newIdx * mult;
        for (let i = insertPos; i < count; i++, mult *= PACKING_CONSTANTS.BYTE_BASIS) {
            const b = Math.floor(existing / mult) % PACKING_CONSTANTS.BYTE_BASIS;
            packed += b * (mult * PACKING_CONSTANTS.BYTE_BASIS);
        }
        return packed as PackedCombo;
    }

    /**
     * For books: returns all possible combinations after removing one "selected at random" enchantment.
     * Based on Minecraft Wiki: "If multiple enchantments were generated, then one selected at random is removed."
     *
     * OPTIMIZED BITWISE VERSION: Avoids unpack/sort/pack cycle and array allocations.
     */
    static removeAdditional(packed: PackedCombo, guaranteedFirstId: number | null, indexToEnchant: number[]): PackedCombo[] {
        const count = this.getCount(packed);
        if (count <= 1) return [packed];

        const possibleResults: PackedCombo[] = [];
        let mult = 1;
        for (let i = 0; i < count; i++, mult *= PACKING_CONSTANTS.BYTE_BASIS) {
            const byteVal = Math.floor(packed / mult) % PACKING_CONSTANTS.BYTE_BASIS;
            const enchant = indexToEnchant[byteVal];
            if (enchant === undefined) continue;
            const enchantId = enchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;

            // Strategy: filter out outcomes where the guaranteed enchant was the one removed.
            if (guaranteedFirstId !== null && enchantId === guaranteedFirstId) continue;

            // Mathematically remove the i-th byte by zeroing it and shifting the upper bytes down
            const lowerPart = packed % mult;
            const nextPacked = (i + 1 < count)
                ? lowerPart + (Math.floor(packed / (mult * PACKING_CONSTANTS.BYTE_BASIS)) * mult)
                : lowerPart;
            
            possibleResults.push(nextPacked as PackedCombo);
        }

        return possibleResults;
    }
}

