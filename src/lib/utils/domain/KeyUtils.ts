/**
 * Constants for bit-packing cache keys for enchantment search state.
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
}
