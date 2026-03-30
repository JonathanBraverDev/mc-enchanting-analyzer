import { PackedEnchant, PackedCombo } from '../../types/index.js';

/**
 * Utility for packing and unpacking enchantment combinations into numbers.
 * Uses a flat lookup table (enchant_id, rank) → byte index for efficient Map key operations.
 */
export class ComboUtils {
    static getEnchantId(packed: PackedEnchant): number { return packed >> 8; }
    static getEnchantRank(packed: PackedEnchant): number { return packed & 0xFF; }

    private static enchantToIndex: Map<number, number> = new Map();
    private static indexToEnchant: number[] = [0];

    static readonly BYTE_MULTIPLIERS = [1, 256, 65536, 16777216, 4294967296, 1099511627776];

    static init(enchantToIndex: Map<number, number>, indexToEnchant: number[]): void {
        this.enchantToIndex = enchantToIndex;
        this.indexToEnchant = indexToEnchant;
    }

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
    static pack(chosen: PackedEnchant[], guaranteedFirstId: number | null): PackedCombo {
        if (chosen.length === 0) return 0;

        let firstPicked: number | null = null;
        const others: number[] = [];

        for (const c of chosen) {
            const id = c >> 8;
            const idx = this.enchantToIndex.get(c);
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
    static unpack(packed: PackedCombo): PackedEnchant[] {
        if (packed === 0) return [];

        const out: PackedEnchant[] = [];
        for (let i = 0; i < 6; i++) {
            const idx = Math.floor(packed / this.BYTE_MULTIPLIERS[i]) % 256;
            if (idx === 0) break;
            out.push(this.indexToEnchant[idx]);
        }
        return out;
    }

    /**
     * For books: returns all possible combinations after removing one "selected at random" enchantment.
     * Based on Minecraft Wiki: "If multiple enchantments were generated, then one selected at random is removed."
     */
    static removeAdditional(packed: PackedCombo, guaranteedFirstId: number | null = null): PackedCombo[] {
        const enchants = this.unpack(packed);
        if (enchants.length <= 1) return [packed];

        const possibleResults: PackedCombo[] = [];
        // Generate all possible N combinations of size N-1 by removing one at random
        for (let i = 0; i < enchants.length; i++) {
            const filtered = [...enchants.slice(0, i), ...enchants.slice(i + 1)];
            possibleResults.push(this.pack(filtered, guaranteedFirstId));
        }

        if (guaranteedFirstId !== null) {
            // Player Perspective: If a player SEES an enchantment in the tooltip,
            // then by definition that enchantment was NOT the one removed.
            // We filter the results to only those that still contain the tooltip enchantment.
            return possibleResults.filter(r => this.unpack(r).some(e => (e >> 8) === guaranteedFirstId));
        }

        return possibleResults;
    }
}
