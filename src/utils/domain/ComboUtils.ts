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
        for (let i = 0; i < 6; i++) {
            if (Math.floor(packed / this.BYTE_MULTIPLIERS[i]) % 256 === 0) return i;
        }
        return 6;
    }

    /**
     * Packs a set of enchantments into a number.
     * Uses a flat byte-per-slot encoding with a prebuilt lookup table.
     */
    static pack(chosen: PackedEnchant[], guaranteedFirstId: number | null, enchantToIndex: Map<number, number>): PackedCombo {
        if (chosen.length === 0) return 0;

        let firstPicked: number | null = null;
        const others: number[] = [];

        for (const c of chosen) {
            const id = c >> 8;
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
        for (let i = 0; i < others.length; i++) {
            packed += others[i] * this.BYTE_MULTIPLIERS[i];
        }

        return packed;
    }

    /**
     * Unpacks a number back into numeric enchantment IDs (id << 8 | rank).
     */
    static unpack(packed: PackedCombo, indexToEnchant: number[]): PackedEnchant[] {
        if (packed === 0) return [];

        const out: PackedEnchant[] = [];
        for (let i = 0; i < 6; i++) {
            const idx = Math.floor(packed / this.BYTE_MULTIPLIERS[i]) % 256;
            if (idx === 0) break;
            out.push(indexToEnchant[idx]);
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
        const newId = newItem >> 8;
        const isNewGuaranteed = guaranteedFirstId !== null && newId === guaranteedFirstId;

        if (count === 0) {
            return newIdx * this.BYTE_MULTIPLIERS[0];
        }

        if (isNewGuaranteed) {
            // Guaranteed enchant goes to position 0; shift all existing bytes right
            let packed = newIdx * this.BYTE_MULTIPLIERS[0];
            for (let i = 0; i < count; i++) {
                const b = Math.floor(existing / this.BYTE_MULTIPLIERS[i]) % 256;
                packed += b * this.BYTE_MULTIPLIERS[i + 1];
            }
            return packed;
        }

        // Non-guaranteed: insert in descending idx order, after guaranteed slot if present
        const sortStart = (guaranteedFirstId !== null && guaranteedInCombo) ? 1 : 0;

        let insertPos = count;
        for (let i = sortStart; i < count; i++) {
            const b = Math.floor(existing / this.BYTE_MULTIPLIERS[i]) % 256;
            if (newIdx > b) {
                insertPos = i;
                break;
            }
        }

        let packed = 0;
        for (let i = 0; i < insertPos; i++) {
            const b = Math.floor(existing / this.BYTE_MULTIPLIERS[i]) % 256;
            packed += b * this.BYTE_MULTIPLIERS[i];
        }
        packed += newIdx * this.BYTE_MULTIPLIERS[insertPos];
        for (let i = insertPos; i < count; i++) {
            const b = Math.floor(existing / this.BYTE_MULTIPLIERS[i]) % 256;
            packed += b * this.BYTE_MULTIPLIERS[i + 1];
        }
        return packed;
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
        for (let i = 0; i < count; i++) {
            const packedEnchant = Math.floor(packed / this.BYTE_MULTIPLIERS[i]) % 256;
            const enchantId = indexToEnchant[packedEnchant] >> 8;

            // Strategy: filter out outcomes where the guaranteed enchant was the one removed.
            if (guaranteedFirstId !== null && enchantId === guaranteedFirstId) continue;

            // Mathematically remove the i-th byte by zeroing it and shifting the upper bytes down
            const lowerPart = packed % this.BYTE_MULTIPLIERS[i];
            const nextPacked = (i + 1 < count)
                ? lowerPart + (Math.floor(packed / this.BYTE_MULTIPLIERS[i+1]) * this.BYTE_MULTIPLIERS[i])
                : lowerPart;
            
            possibleResults.push(nextPacked);
        }

        return possibleResults;
    }
}
