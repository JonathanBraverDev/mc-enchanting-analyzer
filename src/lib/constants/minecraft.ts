/**
 * Version-specific Minecraft enchantment rules and caps.
 */
export const MINECRAFT_RULES = {
    /** Maximum XP level for the enchanting table in modern versions (1.3+). */
    XP_CAP_MODERN: 30,

    /** Maximum XP level for the enchanting table in legacy versions (pre-1.3). */
    XP_CAP_LEGACY: 50,

    /** Divisor used for calculating the enchantability bonus in modern versions (1.3+).
     * Uses a triangular distribution (sum of two random calls). */
    ENCHANTABILITY_DIVISOR_MODERN: 4,

    /** Divisor used for calculating the enchantability bonus in legacy versions (pre-1.1).
     * Uses a flat distribution (single random call). */
    ENCHANTABILITY_DIVISOR_LEGACY: 2,

    /** The fixed divisor used in the formula for determining if additional enchantments are added.
     * P(stop) = (modified_level + 1) / 50. */
    CONTINUE_CHANCE_DIVISOR: 50,

    /** Divisor applied to the modified level before rolling each additional enchantment in modern versions. */
    ADDITIONAL_ENCHANTMENT_LEVEL_DIVISOR_MODERN: 2,

    /** Divisor applied to the modified level before rolling each additional enchantment in legacy versions. */
    ADDITIONAL_ENCHANTMENT_LEVEL_DIVISOR_LEGACY: 4,

    /** Variance range for the modified level multiplier (0.85 to 1.15). */
    RANDOM_BONUS_RANGE: 0.15
};
