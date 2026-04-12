import { ProbUtils } from '../utils/math/ProbUtils.js';

/**
 * Technical limits for enchantment bit-packing and search.
 */
export const ENGINE_LIMITS = {
    MAX_ENCHANTS_PER_ITEM: 6,
    MAX_MODIFIED_LEVEL: 50,
    MAX_XP_LEVEL: 50,
    MAX_RESULTS_SIZE: 5000,
    MAX_QUEUE_SIZE: 1000000,
    MAX_RESULTS_SUMMARY: 100,
    SYSTEM_THRESHOLD_FLOOR: 0.0000000001,
    UNKNOWN_ENCHANT_ID: 255,
    UNKNOWN_MATERIAL_ID: 255
};

/**
 * Default cache configurations.
 */
export const CACHE_CONFIG = {
    COMBO_OTHER_SIZE: 128,
    COMBO_BOOK_SIZE: 64,
    STATS_SIZE: 8,
    POOL_SIZE: 200
};

/**
 * Search logic constants.
 */
export const SEARCH_CONSTANTS = {
    /** Target mass coverage percentages where checkpoints are recorded. */
    CHECKPOINT_TARGETS: [0.1, 0.25, 0.5, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99, 0.999].map(t => ProbUtils.toBigInt(t)),
    
    /** Probability table for continuing to add more enchantments at a given modified level. */
    PROB_CONTINUE_TABLE: Array.from({ length: 65 }, (_, ml) => {
        const val = Math.min((ml + 1) / 50, 1.0); // 50 is ENGINE_LIMITS.MAX_MODIFIED_LEVEL
        return ProbUtils.toBigInt(val);
    })
};
