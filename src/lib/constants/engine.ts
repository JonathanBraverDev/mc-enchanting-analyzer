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
    UNKNOWN_MATERIAL_ID: 255,
    MAX_RESULTS_UNBOUNDED: 1000000,
    MAX_ITERATIONS_UNBOUNDED: 1000000,
    DEFAULT_THRESHOLD: 0.0001,
    DEFAULT_BUFFER_SIZE: 1024
};

/**
 * Constants for enchantment bit-packing and fixed-point arithmetic.
 */
export const PACKING_CONSTANTS = {
    /** 
     * Basis for byte-slot encoding (256). 
     * Used for both individual enchants (Id << 8 | Rank) and combo packing.
     */
    BYTE_BASIS: 256,
    
    /** Bit shift for separating Enchant Id and Rank. */
    ENCHANT_SHIFT: 8,
    
    /** Mask for extracting Rank from a packed enchantment. */
    RANK_MASK: 0xFF,
    
    /** Max possible packed rank-id index for bookkeeping arrays. */
    MAX_RANKED_INDEX: 16384, // (256 max enchants * 64 possible internal ids)
    
    /** Max possible count index for bookkeeping arrays. */
    MAX_COUNT_INDEX: 16,

    /** Max slots in a single packed combo number. */
    MAX_COMBO_SLOTS: 6
};

/**
 * Shared memory pool and heap limits.
 */
export const POOL_CONSTANTS = {
    /** Maximum depth for nested distribution calls. */
    DIST_POOL_DEPTH: 8,
    
    /** Buffer size for individual distribution calculations. */
    DIST_POOL_SLOT_SIZE: 128,
    
    /** Initial capacity for the SearchHeap (TypedArrays). */
    INITIAL_HEAP_CAPACITY: 131072
};

/**
 * High-precision math constants.
 */
export const MATH_CONSTANTS = {
    /** Fixed-point precision shift (2^60). */
    PRECISION_SHIFT: 60n,
    
    /** IEEE 754 mantissa bits for safe float-to-int conversion. */
    FLOAT_MANTISSA_BITS: 53,
    
    /** The scale difference between mantissa bits and our precision target (60 - 53). */
    MANTISSA_TO_FIXED_SHIFT: 7n
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
    /** Target mass coverage percentages where checkpoints are recorded. (As floats) */
    CHECKPOINT_TARGET_FLOATS: [0.1, 0.25, 0.5, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99, 0.999],
    
    /** Max length for the continue table. */
    CONTINUE_TABLE_SIZE: 65,

    /** Max recursion depth for iterative mass forwarding. */
    MAX_RECURSION_DEPTH: 10
};
