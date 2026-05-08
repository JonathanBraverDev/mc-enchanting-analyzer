/**
 * Constants for bit-packing cache keys for enchantment calculations.
 */
export const KEY_SHIFT_ITEM = 0;
export const KEY_SHIFT_MATERIAL = 6;
export const KEY_SHIFT_LEVEL = 12;

/**
 * Utility for generating bit-packed cache keys.
 */
export class KeyUtils {
    public static getPackedKey(
        itemId: number,
        materialId: number,
        modLevel: number
    ): number {
        return (itemId << KEY_SHIFT_ITEM) | (materialId << KEY_SHIFT_MATERIAL) | (modLevel << KEY_SHIFT_LEVEL);
    }

    /**
     * Packs stats cache parameters into a single number key, omitting `limit`.
     * This allows a more precise (higher-limit) result to satisfy a coarser request
     * via the uncertainty check, enabling cross-tier cache hits.
     */
    public static getStatsKey(
        itemId: number,
        materialId: number,
        level: number
    ): number {
        return (itemId << KEY_SHIFT_ITEM) | (materialId << KEY_SHIFT_MATERIAL) | (level << KEY_SHIFT_LEVEL);
    }
}
