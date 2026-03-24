import { PackedEnchant, PackedCombo } from '../types.js';

/**
 * Utility for packing and unpacking enchantment combinations into BigInts.
 */
export class ComboUtils {
    static getEnchantId(packed: PackedEnchant): number { return packed >> 8; }
    static getEnchantRank(packed: PackedEnchant): number { return packed & 0xFF; }
    static getCount(packed: PackedCombo): number { return Number(packed >> 60n); }
    
    /**
     * Packs a set of enchantments into a bigint.
     * Each enchantment is (id << 4 | rank), 12 bits total.
     */
    static pack(chosen: PackedEnchant[], guaranteedFirstId: number | null): PackedCombo {
        if (chosen.length === 0) return 0n;
        
        let firstPicked: number | null = null;
        const others: number[] = [];
        
        for (const c of chosen) {
            const id = c >> 8;
            const rank = c & 0xFF;
            const val = ((id & 0x7F) << 3) | (rank & 0x07);
            if (guaranteedFirstId !== null && id === guaranteedFirstId && firstPicked === null) {
                firstPicked = val;
            } else {
                others.push(val);
            }
        }
        
        others.sort((a, b) => b - a);
        if (firstPicked !== null) others.unshift(firstPicked);
        
        let packed = 0n;
        for (let i = 0; i < others.length; i++) {
            packed |= BigInt(others[i]) << BigInt(i * 10);
        }
        packed |= BigInt(others.length) << 60n;
        
        return packed;
    }

    /**
     * Unpacks a bigint back into numeric enchantment IDs (id << 8 | rank).
     */
    static unpack(packed: PackedCombo): PackedEnchant[] {
        if (packed === 0n) return [];
        const count = Number(packed >> 60n);
        const core = packed & ((1n << 60n) - 1n);
        
        const out: PackedEnchant[] = [];
        for (let i = 0; i < count; i++) {
            const val = Number((core >> BigInt(i * 10)) & 0x3FFn);
            const id = val >> 3;
            const rank = val & 0x07;
            out.push((id << 8) | rank);
        }
        return out;
    }
}
