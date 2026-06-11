/** Flex search LRU capacities. */
export const FLEX_RUN_CACHE_LIMITS = Object.freeze({
    RUNS: 128
});

/** Shared grouped-graph traversal values that mirror vanilla enchanting state transitions. */
export const FLEX_GRAPH_TRAVERSAL = Object.freeze({
    ROOT_EXCLUSION_MASK: 0n,
    ROOT_ENCHANT_COUNT: 0,
    ENCHANT_COUNT_INCREMENT: 1,
    SINGLE_ENCHANT_BOOK_TERMINAL_COUNT: 1
});

/** Sizing policy for the checkpoint frontier heap and per-graph position lookup tables. */
export const FLEX_FRONTIER_CONFIG = Object.freeze({
    INITIAL_CAPACITY: 8192,
    POSITION_INDEX_INITIAL_CAPACITY: 32768,
    POSITION_INDEX_MAX_LOAD_FACTOR: 0.7,
    MIN_ASYNC_CHUNK_ITERATIONS: 1,
    GROWTH_FACTOR: 2
});
