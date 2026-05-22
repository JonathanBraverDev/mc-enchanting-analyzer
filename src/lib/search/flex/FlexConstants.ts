/** Flex-owned LRU capacities. Keep these separate from V7 SearchStateCache and legacy Plex. */
export const FLEX_CACHE_LIMITS = Object.freeze({
    /** Resumable Flex XP-cell runs. Mirrors V7/Plex run-cache budgets for fair comparison. */
    RUNS: 128,
    /** Mutated-registry reduced-key checks are small and cheap enough to retain more broadly. */
    REDUCED_KEY_INVARIANTS: 256
});

export const FLEX_INVARIANT_LIMITS = Object.freeze({
    MIN_CONFLICTS: 1,
    DEFAULT_MAX_CONFLICTS: 10
});
