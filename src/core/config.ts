
export interface SearchMode {
    thresholdBook: number;
    thresholdOther: number;
    limitBook: number;
    limitOther: number;
    status: string;
}

export type SearchLevel = 'coarse' | 'standard' | 'deep' | 'ultra' | 'done';

export const UI_TEXTS = {
    PAGE_TITLE: "Minecraft Enchantment Analyzer",
    LOGO_TEXT: "Analyzer",
    STATUS_POSTFIX: "...",
    STATUS_SEARCHING: "Searching",
    STATUS_REFINING: "Refining",
    STATUS_FINALIZING: "Finalizing",
    STATUS_OPTIMIZING: "Optimizing",
    STATUS_COMPLETE: "Complete",
    STATUS_LOADING_VERSION: "Loading version",
    STATUS_SWITCHING_CATEGORY: "Switching category",
    STATUS_CALCULATING: "Calculating combinations",
    STATUS_ERROR_LOADING: "Initialization failed",
    STATUS_ERROR_CALC: "Calculation failed",
    STATUS_CHART_PREPARING: "Scanning probabilities",
    STATUS_CHART_SWEEPING: "Mapping levels"
};

export const UI_DEFAULTS = {
    MAX_TOP_COMBOS_DISPLAY: 10,
    MAX_XP_LEVEL: 30,
    DEFAULT_XP_LEVEL: 30,
    INPUT_DEBOUNCE_MS: 50,
    CHART_METRIC_ANY: "any",
    CHART_METRIC_RANKS: "ranks",
    CHART_METRIC_COUNT: "count"
};

export const SEARCH_MODES: Record<Exclude<SearchLevel, 'done'>, SearchMode> = {
    coarse: {
        thresholdBook: 0.05,
        thresholdOther: 0.01,
        limitBook: 5000,
        limitOther: 2000,
        status: UI_TEXTS.STATUS_SEARCHING
    },
    standard: {
        thresholdBook: 0.005,
        thresholdOther: 0.0005,
        limitBook: 20000,
        limitOther: 10000,
        status: UI_TEXTS.STATUS_REFINING
    },
    deep: {
        thresholdBook: 0.0005,
        thresholdOther: 0.00005,
        limitBook: 60000,
        limitOther: 30000,
        status: UI_TEXTS.STATUS_FINALIZING
    },
    ultra: {
        thresholdBook: 0.0001,
        thresholdOther: 0.000005,
        limitBook: 150000,
        limitOther: 75000,
        status: UI_TEXTS.STATUS_OPTIMIZING
    }
};

export const SEARCH_LEVEL_COLORS: Record<SearchLevel, { bg: string; text: string }> = {
    coarse:   { bg: 'rgba(255, 193, 7, 0.15)',   text: '#ffca28' },
    standard: { bg: 'rgba(76, 175, 80, 0.15)',   text: '#66bb6a' },
    deep:     { bg: 'rgba(33, 150, 243, 0.15)',  text: '#42a5f5' },
    ultra:    { bg: 'rgba(156, 39, 176, 0.15)',  text: '#ab47bc' },
    done:     { bg: 'rgba(255, 255, 255, 0.05)', text: 'var(--text-muted)' }
};

export function getParamsForMode(level: Exclude<SearchLevel, 'done'>, isBook: boolean) {
    const mode = SEARCH_MODES[level];
    return {
        threshold: isBook ? mode.thresholdBook : mode.thresholdOther,
        limit: isBook ? mode.limitBook : mode.limitOther,
        status: mode.status
    };
}

export const ENGINE_DEFAULTS = {
    MAX_ENCHANTS_PER_ITEM: 6,
    MAX_MODIFIED_LEVEL_FOR_CONTINUING: 50,
    RNG_STEPS_FOR_DISTRIBUTION: 100,
    PRUNE_THRESHOLD_DENOMINATOR: 100n,
    MASS_ACCOUNTED_THRESHOLD_DENOMINATOR: 10000n,
    MAX_COUNT_STATS: 8,
    FALLBACK_LIMIT_BOOK: 25000,
    FALLBACK_LIMIT_HIGH_RES: 25000,
    FALLBACK_LIMIT_LOW_RES: 10000,
    MAX_QUEUE_SIZE: 60000,
    MAX_RESULTS_SIZE: 5000,
    CACHE_SIZE_COMBO_OTHER: 128,
    CACHE_SIZE_COMBO_BOOK: 64,
    CACHE_SIZE_STATS: 8,
    MAX_RESULTS_SUMMARY: 100,
    MAX_RESULTS_SUMMARY_OPTIMIZED_THRESHOLD: 250,
    MAX_RESULTS_SNAPSHOT: 5000,
    MAX_RESULTS_HI_RES: 65535,
    UNKNOWN_CATEGORY_ID: 63,
    UNKNOWN_MATERIAL_ID: 63,
    UNKNOWN_ENCHANT_ID: 255,
    MAX_XP_LEVEL: 50
};

/**
 * Shared threshold-to-limit lookup used by both EnchantEngine and StatAggregator.
 */
export function getSearchLimit(cat: string, threshold: number, maxIterations?: number): number {
    if (maxIterations !== undefined) return maxIterations;
    if (cat === "book") return ENGINE_DEFAULTS.FALLBACK_LIMIT_BOOK;
    return threshold < 0.0001 ? ENGINE_DEFAULTS.FALLBACK_LIMIT_HIGH_RES : ENGINE_DEFAULTS.FALLBACK_LIMIT_LOW_RES;
}
