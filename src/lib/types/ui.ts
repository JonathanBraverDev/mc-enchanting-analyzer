import type { EnchantStats } from '#types/engine.js';
import type { MassAccountingBreakdown } from '#types/mass.js';

/**
 * Human-readable enchantment stats.
 *
 * @public
 */
export interface EnchantInsights {
    /** Map of enchantment rank labels to their total cumulative probability. */
    ranks: Record<string, number>;
    /** Map of base enchantment labels to their total probability on the item at any rank. */
    any: Record<string, number>;
    /** Map of enchantment counts to their total probability. */
    count: Record<number, number>;
    /** Map of human-readable combo labels to their joint probability. */
    combos: Record<string, number>;

    /** Reliability of the results (Resolved mass: 0.0 to 1.0). */
    accuracy: number;
    /** Complete diagnostic breakdown of all mass states. */
    accounting: MassAccountingBreakdown;
    /** Observed displayed-clue diagnostics. Present only for clue-conditioned stats. */
    clue?: {
        /** Human-readable observed clue name, including rank. */
        name: string;
        /** Absolute displayed-clue mass used for Bayesian conditioning. */
        knownSpace: number;
    } | undefined;
    /** Map of possible shown table clues to their original unconditioned probabilities. Omitted for clue-conditioned stats. */
    shownClueDistribution?: Record<string, number> | undefined;
}

export interface NameResolver {
    getFullEnchantName(n: number): string;
    getEnchantName(id: number): string;
}

/**
 * Single data point in a level sweep (e.g., for charting).
 */
export interface SweepData {
    l: number; // XP Level
    s: EnchantStats; // Raw stats from the enchant engine
}

/**
 * Supported sorting modes for enchantment combinations.
 *
 * @public
 */
export type ResultSortMode = 'prob' | 'count' | 'rank';

/**
 * Dataset configuration for Chart.js.
 */
export interface ChartDataset {
    label: string;
    data: number[];
    borderColor: string;
    backgroundColor: string;
    borderWidth: number;
    tension: number;
    pointRadius: number;
    borderDash?: number[];
}
