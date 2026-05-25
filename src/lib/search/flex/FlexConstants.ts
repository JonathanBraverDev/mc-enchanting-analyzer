/** Flex grouped-runtime LRU capacities. Keep these separate from legacy diagnostic caches. */
export const FLEX_RUN_CACHE_LIMITS = Object.freeze({
    /** Resumable XP-cell runs. */
    RUNS: 128,
    /** Mutated-registry reduced-key checks are small and cheap enough to retain more broadly. */
    REDUCED_KEY_INVARIANT_CHECKS: 256
});

/** Bounds for reduced-key invariant checks used to decide Flex state identity mode. */
export const FLEX_REDUCED_KEY_INVARIANT_LIMITS = Object.freeze({
    MIN_REPORTED_CONFLICTS: 1,
    DEFAULT_MAX_REPORTED_CONFLICTS: 10
});

/** Shared grouped-graph traversal values that mirror vanilla enchanting state transitions. */
export const FLEX_GRAPH_TRAVERSAL = Object.freeze({
    ROOT_EXCLUSION_MASK: 0n,
    ROOT_ENCHANT_COUNT: 0,
    ENCHANT_COUNT_INCREMENT: 1,
    SINGLE_ENCHANT_BOOK_TERMINAL_COUNT: 1
});

/** Sizing policy for the grouped graph node lookup table. */
export const FLEX_GRAPH_INDEX_CONFIG = Object.freeze({
    INITIAL_CAPACITY: 4096,
    MAX_LOAD_FACTOR: 0.7,
    GROWTH_FACTOR: 2
});

/** Sizing policy for the checkpoint frontier heap and per-graph position lookup tables. */
export const FLEX_FRONTIER_CONFIG = Object.freeze({
    INITIAL_CAPACITY: 8192,
    POSITION_INDEX_INITIAL_CAPACITY: 32768,
    POSITION_INDEX_MAX_LOAD_FACTOR: 0.7,
    MIN_ASYNC_CHUNK_ITERATIONS: 1,
    GROWTH_FACTOR: 2
});

/** Sentinel values shared by Flex typed-array indexes. */
export const FLEX_INDEX_SENTINELS = Object.freeze({
    EMPTY_SLOT: 0,
    OCCUPIED_SLOT: 1,
    TOMBSTONE_SLOT: 2,
    MISSING_INDEX: -1
});

/** Hash mixing constants used by Flex numeric indexes. */
export const FLEX_HASH_CONFIG = Object.freeze({
    LOW_32_BITS_MASK: 0xffffffffn,
    HIGH_32_BITS_SHIFT: 32n,
    GOLDEN_RATIO_32: 0x9E3779B1,
    STATE_KEY_MULTIPLIER: 0x85EBCA6B,
    PROGRAM_KEY_MULTIPLIER: 0xC2B2AE35,
    AVALANCHE_MULTIPLIER_1: 0x7FEB352D,
    AVALANCHE_MULTIPLIER_2: 0x846CA68B,
    AVALANCHE_SHIFT_1: 16,
    AVALANCHE_SHIFT_2: 15
});
