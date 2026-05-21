/** Flex-owned LRU capacities. Keep these separate from V7 SearchStateCache and legacy Plex. */
export const FLEX_CACHE_LIMITS = Object.freeze({
    /** Resumable Flex XP-cell runs. Mirrors V7/Plex run-cache budgets for fair comparison. */
    RUNS: 128
});
