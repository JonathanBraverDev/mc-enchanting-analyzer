/**
 * Constants for bit-packing cache keys for enchantment calculations.
 */
export const KEY_SHIFT_CAT = 0n;
export const KEY_SHIFT_MAT = 6n;
export const KEY_SHIFT_LEVEL = 12n;
export const KEY_SHIFT_GUARANTEED = 20n;
export const KEY_SHIFT_LIMIT = 28n;

/**
 * Utility for generating bit-packed cache keys.
 */
export class KeyUtils {
    /**
     * Packs enchantment search parameters into a single BigInt key.
     * Used for frontier/combo caches (includes `limit` so search state is limit-specific).
     */
    public static getPackedKey(
        catId: number,
        matId: number,
        modLevel: number,
        guaranteedId: number,
        limit: number
    ): bigint {
        let key = BigInt(catId) << KEY_SHIFT_CAT;
        key |= BigInt(matId) << KEY_SHIFT_MAT;
        key |= BigInt(modLevel) << KEY_SHIFT_LEVEL;
        key |= BigInt(guaranteedId) << KEY_SHIFT_GUARANTEED;
        key |= BigInt(limit) << KEY_SHIFT_LIMIT;

        return key;
    }

    /**
     * Packs stats cache parameters into a single BigInt key, omitting `limit`.
     * This allows a more precise (higher-limit) result to satisfy a coarser request
     * via the uncertainty check, enabling cross-tier cache hits.
     */
    public static getStatsKey(
        catId: number,
        matId: number,
        level: number,
        guaranteedId: number
    ): bigint {
        let key = BigInt(catId) << KEY_SHIFT_CAT;
        key |= BigInt(matId) << KEY_SHIFT_MAT;
        key |= BigInt(level) << KEY_SHIFT_LEVEL;
        key |= BigInt(guaranteedId) << KEY_SHIFT_GUARANTEED;

        return key;
    }
}
