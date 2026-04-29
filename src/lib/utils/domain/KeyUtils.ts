/**
 * Constants for bit-packing cache keys for enchantment calculations.
 */
export const KEY_SHIFT_CAT = 0;
export const KEY_SHIFT_MAT = 6;
export const KEY_SHIFT_LEVEL = 12;

/**
 * Utility for generating bit-packed cache keys.
 */
export class KeyUtils {
    public static getPackedKey(
        catId: number,
        matId: number,
        modLevel: number
    ): number {
        return (catId << KEY_SHIFT_CAT) | (matId << KEY_SHIFT_MAT) | (modLevel << KEY_SHIFT_LEVEL);
    }

    /**
     * Packs stats cache parameters into a single number key, omitting `limit`.
     * This allows a more precise (higher-limit) result to satisfy a coarser request
     * via the uncertainty check, enabling cross-tier cache hits.
     */
    public static getStatsKey(
        catId: number,
        matId: number,
        level: number
    ): number {
        return (catId << KEY_SHIFT_CAT) | (matId << KEY_SHIFT_MAT) | (level << KEY_SHIFT_LEVEL);
    }
}
