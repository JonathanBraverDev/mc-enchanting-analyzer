
import { RefinementLevelName, SearchCheckpoint } from '#types/index.js';

export interface RefinementCheckpointPreset {
    thresholdBook: number;
    thresholdOther: number;
    limitBook: number;
    limitOther: number;
    targetClassifiedMassBook?: number | undefined;
    targetClassifiedMassOther?: number | undefined;
    status: string;
}

export type RefinementStatusLevel = RefinementLevelName | 'done';
export interface RefinementSearchCheckpoint extends SearchCheckpoint {
    refinementLevel: RefinementLevelName;
    status: string;
}

export type StatsCheckpoint = SearchCheckpoint;

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
    STATUS_SWITCHING_ITEM: "Switching item",
    STATUS_CALCULATING: "Calculating combinations",
    STATUS_ERROR_LOADING: "Initialization failed",
    STATUS_ERROR_CALC: "Calculation failed",
    STATUS_CHART_PREPARING: "Scanning probabilities",
    STATUS_CHART_SWEEPING: "Mapping levels",
    STATUS_CHART_COMPLETE: "Complete"
};

export const UI_DEFAULTS = {
    MAX_TOP_COMBOS_DISPLAY: 10,
    DEFAULT_VIEW_XP_CAP: 30, // Default for modern UI, overridden by version cap
    DEFAULT_XP_LEVEL: 30,
    INPUT_DEBOUNCE_MS: 50,
    CHART_METRIC_ANY: "any",
    CHART_METRIC_RANKS: "ranks",
    CHART_METRIC_COUNT: "count"
};

export const REFINEMENT_CHECKPOINTS: Record<RefinementLevelName, RefinementCheckpointPreset> = {
    coarse: {
        thresholdBook: 0.007,
        thresholdOther: 0.001,
        limitBook: 5000,
        limitOther: 2000,
        status: UI_TEXTS.STATUS_SEARCHING
    },
    standard: {
        thresholdBook: 0.001,
        thresholdOther: 0.00005,
        limitBook: 20000,
        limitOther: 10000,
        status: UI_TEXTS.STATUS_REFINING
    },
    deep: {
        thresholdBook: 0.00005,
        thresholdOther: 0.000005,
        limitBook: 60000,
        limitOther: 30000,
        status: UI_TEXTS.STATUS_FINALIZING
    },
    ultra: {
        thresholdBook: 0.00001,
        thresholdOther: 0.000001,
        limitBook: 150000,
        limitOther: 75000,
        status: UI_TEXTS.STATUS_OPTIMIZING
    }
};

export const DEFAULT_STATS_REFINEMENT_LEVEL: RefinementLevelName = 'standard';

export const REFINEMENT_LEVEL_COLORS: Record<RefinementStatusLevel, { bg: string; text: string }> = {
    coarse:   { bg: 'rgba(255, 193, 7, 0.15)',   text: '#ffca28' },
    standard: { bg: 'rgba(76, 175, 80, 0.15)',   text: '#66bb6a' },
    deep:     { bg: 'rgba(33, 150, 243, 0.15)',  text: '#42a5f5' },
    ultra:    { bg: 'rgba(156, 39, 176, 0.15)',  text: '#ab47bc' },
    done:     { bg: 'rgba(255, 255, 255, 0.05)', text: 'var(--text-muted)' }
};

export function getSearchCheckpointForRefinement(level: RefinementLevelName, isBook: boolean): RefinementSearchCheckpoint {
    const mode = REFINEMENT_CHECKPOINTS[level];
    const checkpoint = getCheckpointFromPreset(mode, isBook);

    return {
        refinementLevel: level,
        ...checkpoint,
        status: mode.status
    };
}

export function getDefaultStatsCheckpoint(isBook: boolean): StatsCheckpoint {
    return getCheckpointFromPreset(REFINEMENT_CHECKPOINTS[DEFAULT_STATS_REFINEMENT_LEVEL], isBook);
}

function getCheckpointFromPreset(mode: RefinementCheckpointPreset, isBook: boolean): StatsCheckpoint {
    const targetClassifiedMass = isBook ? mode.targetClassifiedMassBook : mode.targetClassifiedMassOther;

    return {
        threshold: isBook ? mode.thresholdBook : mode.thresholdOther,
        limit: isBook ? mode.limitBook : mode.limitOther,
        ...(targetClassifiedMass === undefined ? {} : { targetClassifiedMass })
    };
}
