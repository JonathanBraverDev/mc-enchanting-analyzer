/**
 * Constants for bit-packing cache keys for enchantment calculations.
 */
export const KEY_SHIFT_CAT = 0n;
export const KEY_SHIFT_MAT = 6n;
export const KEY_SHIFT_LEVEL = 12n;
export const KEY_SHIFT_GUARANTEED = 20n;
export const KEY_SHIFT_LIMIT = 28n;
export const KEY_SHIFT_RESULTS_LIMIT = 48n;
export const KEY_SHIFT_THRESHOLD = 64n;

/**
 * Utility for generating bit-packed cache keys.
 */
export class KeyUtils {
    /**
     * Packs enchantment search parameters into a single BigInt key.
     */
    public static getPackedKey(
        catId: number,
        matId: number,
        modLevel: number,
        guaranteedId: number,
        limit: number,
        resultsLimit: number,
        threshold?: number
    ): bigint {
        let key = BigInt(catId) << KEY_SHIFT_CAT;
        key |= BigInt(matId) << KEY_SHIFT_MAT;
        key |= BigInt(modLevel) << KEY_SHIFT_LEVEL;
        key |= BigInt(guaranteedId) << KEY_SHIFT_GUARANTEED;
        key |= BigInt(limit) << KEY_SHIFT_LIMIT;
        key |= BigInt(resultsLimit) << KEY_SHIFT_RESULTS_LIMIT;

        if (threshold !== undefined) {
            const tIdx = BigInt(Math.max(0, Math.min(255, Math.round(-Math.log10(threshold)))));
            key |= tIdx << KEY_SHIFT_THRESHOLD;
        }

        return key;
    }
}
