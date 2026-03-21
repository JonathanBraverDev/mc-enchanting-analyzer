import { PackedEnchant, PackedCombo } from './types.js';

/**
 * Utility functions for version parsing and comparison.
 */
export const VersionUtils = {
    /**
     * Parses a version string into an array of numbers.
     */
    parse: (v: string): number[] => (v.match(/\d+/g) || []).map(Number),

    /**
     * Compares two version strings.
     */
    compare: (v1: string, v2: string): number => {
        const p1 = VersionUtils.parse(v1);
        const p2 = VersionUtils.parse(v2);
        const maxLen = Math.max(p1.length, p2.length);
        for (let i = 0; i < maxLen; i++) {
            const a = p1[i] || 0;
            const b = p2[i] || 0;
            if (a > b) return 1;
            if (a < b) return -1;
        }
        return 0;
    },

    /**
     * Checks if a version is within a specific range.
     */
    isInRange: (target: string, start?: string, end: string = "99.9"): boolean => {
        if (!start) return true;
        return VersionUtils.compare(target, start) >= 0 && VersionUtils.compare(target, end) <= 0;
    }
};

/**
 * Utilities for handling Roman numerals and enchantment names.
 */
export class RomanUtils {
    /**
     * Converts a numeric rank to a Roman numeral based on the provided map.
     */
    static rankToRoman(rank: number, romanMap: { [key: string]: number }): string {
        return Object.keys(romanMap)[rank - 1] || rank.toString();
    }

    /**
     * Extracts Roman numeral value from a string using the provided map.
     */
    static getRomanValue(r: string, romanMap: { [key: string]: number }): number {
        return romanMap[r] || 0;
    }

    /**
     * Gets the base name of an enchantment (removes level).
     */
    static getBaseName(fullName: string, romanMap: { [key: string]: number }): string {
        const parts = fullName.split(" ");
        const last = parts[parts.length - 1];
        return Object.keys(romanMap).includes(last) ? parts.slice(0, -1).join(" ") : fullName;
    }
}

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
            const val = (id << 4) | (rank & 0x0F);
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
            packed |= BigInt(others[i]) << BigInt(i * 12);
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
            const val = Number((core >> BigInt(i * 12)) & 0xFFFn);
            const id = val >> 4;
            const rank = val & 0x0F;
            out.push((id << 8) | rank);
        }
        return out;
    }
}
