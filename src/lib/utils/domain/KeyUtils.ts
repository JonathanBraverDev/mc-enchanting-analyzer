import { KEY_PACKING_CONSTANTS } from '#constants/engine.js';

/**
 * Utility for generating bit-packed cache keys.
 */
export class KeyUtils {
    /**
     * Packs enchantment search parameters into a single number key.
     * Used for frontier/combo caches. `limit` is intentionally excluded so that
     * a deeper search tier can resume the frontier cached by a coarser tier
     * (cross-tier resumability).
     * Total bits: cat(6) + mat(6) + level(8) + guaranteed(8) = 28 bits — fits in a JS safe integer.
     */
    public static getPackedKey(
        catId: number,
        matId: number,
        modLevel: number,
        guaranteedId: number
    ): number {
        return (catId << KEY_PACKING_CONSTANTS.SHIFT_CAT) | 
               (matId << KEY_PACKING_CONSTANTS.SHIFT_MAT) | 
               (modLevel << KEY_PACKING_CONSTANTS.SHIFT_LEVEL) | 
               (guaranteedId << KEY_PACKING_CONSTANTS.SHIFT_GUARANTEED);
    }

    /**
     * Packs stats cache parameters into a single number key, omitting `limit`.
     * This allows a more precise (higher-limit) result to satisfy a coarser request
     * via the uncertainty check, enabling cross-tier cache hits.
     */
    public static getStatsKey(
        catId: number,
        matId: number,
        level: number,
        guaranteedId: number
    ): number {
        return (catId << KEY_PACKING_CONSTANTS.SHIFT_CAT) | 
               (matId << KEY_PACKING_CONSTANTS.SHIFT_MAT) | 
               (level << KEY_PACKING_CONSTANTS.SHIFT_LEVEL) | 
               (guaranteedId << KEY_PACKING_CONSTANTS.SHIFT_GUARANTEED);
    }
}
