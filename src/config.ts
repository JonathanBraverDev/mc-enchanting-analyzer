
export interface SearchMode {
    thresholdBook: number;
    thresholdOther: number;
    limitBook: number;
    limitOther: number;
    status: string;
}

export type SearchLevel = 'coarse' | 'standard' | 'deep' | 'ultra' | 'done';

export const SEARCH_MODES: Record<Exclude<SearchLevel, 'done'>, SearchMode> = {
    coarse: {
        thresholdBook: 0.05,
        thresholdOther: 0.01,
        limitBook: 5000,
        limitOther: 2000,
        status: "Searching..."
    },
    standard: {
        thresholdBook: 0.005,
        thresholdOther: 0.0005,
        limitBook: 20000,
        limitOther: 10000,
        status: "Refining..."
    },
    deep: {
        thresholdBook: 0.0005,
        thresholdOther: 0.00005,
        limitBook: 60000,
        limitOther: 30000,
        status: "Finalizing..."
    },
    ultra: {
        thresholdBook: 0.0001,
        thresholdOther: 0.000005,
        limitBook: 150000,
        limitOther: 75000,
        status: "Optimizing..."
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
