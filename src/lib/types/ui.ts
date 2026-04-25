import type { CalculationStats } from '#types/engine.js';
import type { MassAccounting } from '#types/mass.js';

/**
 * Human-readable enchantment calculation statistics.
 */
export interface EnchantInsights {
    ranks: Record<string, number>;
    any: Record<string, number>;
    count: Record<number, number>;
    combos: Record<string, number>;
    
    /** Reliability of the results (Resolved mass: 0.0 to 1.0). */
    accuracy: number;
    /** Complete diagnostic breakdown of all mass states. */
    accounting: MassAccounting;
    /** Map of possible clue enchantments to their original unconditioned probabilities. */
    clues: Record<string, number>;
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
    s: CalculationStats; // Raw stats from the calculation engine
}

/**
 * Supported sorting modes for enchantment combinations.
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
