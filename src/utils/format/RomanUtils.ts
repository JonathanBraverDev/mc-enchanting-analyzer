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
