/** Flex grouped-runtime LRU capacities. Keep these separate from legacy diagnostic caches. */
export const FLEX_CACHE_LIMITS = Object.freeze({
    /** Resumable XP-cell runs. */
    RUNS: 128,
    /** Mutated-registry reduced-key checks are small and cheap enough to retain more broadly. */
    REDUCED_KEY_INVARIANTS: 256
});

export const FLEX_INVARIANT_LIMITS = Object.freeze({
    MIN_CONFLICTS: 1,
    DEFAULT_MAX_CONFLICTS: 10
});

/** Initial sizing and load factors for Flex's open-addressed hot-path indexes. */
export const FLEX_INDEX_LIMITS = Object.freeze({
    GRAPH_INITIAL_CAPACITY: 4096,
    FRONTIER_INITIAL_CAPACITY: 8192,
    FRONTIER_GRAPH_POSITION_INITIAL_CAPACITY: 32768,
    GRAPH_MAX_LOAD_FACTOR: 0.7,
    FRONTIER_MAX_LOAD_FACTOR: 0.7,
    GROWTH_FACTOR: 2
});

/** Sentinel values shared by Flex typed-array indexes. */
export const FLEX_INDEX_SENTINELS = Object.freeze({
    EMPTY_SLOT: 0,
    OCCUPIED_SLOT: 1,
    DELETED_SLOT: 2,
    MISSING_VALUE: -1
});

/** Hash mixing constants used by Flex numeric indexes. */
export const FLEX_HASH_CONSTANTS = Object.freeze({
    U32_MASK: 0xffffffffn,
    U32_SHIFT: 32n,
    GOLDEN_RATIO_32: 0x9E3779B1,
    STATE_KEY_MULTIPLIER: 0x85EBCA6B,
    PROGRAM_KEY_MULTIPLIER: 0xC2B2AE35,
    AVALANCHE_MULTIPLIER_1: 0x7FEB352D,
    AVALANCHE_MULTIPLIER_2: 0x846CA68B,
    AVALANCHE_SHIFT_1: 16,
    AVALANCHE_SHIFT_2: 15
});
