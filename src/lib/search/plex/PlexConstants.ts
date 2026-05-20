/** Plex-owned LRU capacities. Keep these separate from V7 SearchStateCache. */
export const PLEX_CACHE_LIMITS = Object.freeze({
    /** Resumable Plex XP-cell runs. Mirrors V7's run-cache budget for fair comparison. */
    RUNS: 128,
    /** Mutated-registry reduced-key checks are small and cheap enough to retain more broadly. */
    REDUCED_KEY_INVARIANTS: 256
});

/** Reduced-key invariant sampling limits. */
export const PLEX_INVARIANT_LIMITS = Object.freeze({
    MIN_CONFLICTS: 1,
    DEFAULT_MAX_CONFLICTS: 10,
    SERVICE_CONFLICT_SAMPLE_SIZE: 1
});

/** Initial sizing and load factors for Plex's open-addressed indexes. */
export const PLEX_INDEX_LIMITS = Object.freeze({
    GRAPH_INITIAL_CAPACITY: 256,
    GRAPH_MAX_LOAD_FACTOR: 0.7,
    FRONTIER_INITIAL_CAPACITY: 512,
    FRONTIER_MAX_LOAD_FACTOR: 0.65,
    GROWTH_FACTOR: 2
});

/** Sentinel values shared by Plex typed-array indexes. */
export const PLEX_INDEX_SENTINELS = Object.freeze({
    EMPTY_SLOT: 0,
    OCCUPIED_SLOT: 1,
    DELETED_SLOT: 2,
    MISSING_VALUE: -1
});

/** Hash mixing constants used by Plex's numeric indexes. */
export const PLEX_HASH_CONSTANTS = Object.freeze({
    U32_MASK: 0xffffffffn,
    U32_SHIFT: 32n,
    U32_BASIS: 0x100000000,
    GOLDEN_RATIO_32: 0x9E3779B1,
    STATE_KEY_MULTIPLIER: 0x85EBCA6B,
    AVALANCHE_MULTIPLIER_1: 0x7FEB352D,
    AVALANCHE_MULTIPLIER_2: 0x846CA68B,
    AVALANCHE_SHIFT_1: 16,
    AVALANCHE_SHIFT_2: 15
});

/** Plex graph rule constants that describe Minecraft-compatible state transitions. */
export const PLEX_GRAPH_RULES = Object.freeze({
    ROOT_COUNT: 0,
    ROOT_EXCLUSION_MASK: 0n,
    FIRST_CHILD_COUNT: 1,
    NEXT_LEVEL_DIVISOR: 2,
    SINGLE_BOOK_ENCHANT_LIMIT: 1
});

/** Choice-expression shape constants. */
export const PLEX_CHOICE_RULES = Object.freeze({
    FIXED_ALTERNATIVE_COUNT: 1
});

/** Compatibility constants for Minecraft's enchanted-book removal rule. */
export const PLEX_BOOK_RULES = Object.freeze({
    MIN_REMOVAL_SLOT_COUNT: 2
});

/** Dense ID and key-partition constants for Plex interning tries. */
export const PLEX_INTERNING_CONSTANTS = Object.freeze({
    FIRST_CHOICE_ID: 1,
    EMPTY_PAYLOAD_ID: 0,
    FIRST_PAYLOAD_ID: 1,
    PAYLOAD_KEY_STRIDE: 2,
    PAYLOAD_CHOICE_KEY_OFFSET: 1,
    EMPTY_PAYLOAD_KEY: 'f=|c='
});
