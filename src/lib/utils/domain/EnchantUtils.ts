import { RomanUtils } from '#utils/format/RomanUtils.js';

/**
 * Interface representing a structured enchantment name and rank.
 */
export interface EnchantmentResult {
    name: string;
    rank: number;
}

/**
 * Utilities for structured enchantment parsing and handling.
 */
export class EnchantUtils {
    /**
     * Parses an enchantment name with rank (e.g., "Efficiency IV") into a structured object.
     */
    public static parse(fullName: string | null, romanMap: { [key: string]: number }): EnchantmentResult | null {
        if (!fullName) return null;

        const parts = fullName.trim().split(/\s+/);
        if (parts.length < 2) return { name: fullName, rank: 1 };

        const rankStr = parts[parts.length - 1] ?? '';
        let rank: number;
        try {
            rank = RomanUtils.getRomanValue(rankStr, romanMap);
        } catch {
            return { name: fullName, rank: 1 };
        }

        return {
            name: parts.slice(0, -1).join(' '),
            rank: rank
        };
    }

}
