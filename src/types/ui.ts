import type { CalculationStats } from './engine.js';

/**
 * Human-readable enchantment calculation statistics.
 */
export interface EnchantInsights {
    ranks: Record<string, number>;
    any: Record<string, number>;
    count: Record<number, number>;
    combos: Record<string, number>;
    uncertainty: number;
    pruned?: number;
    roundingError?: number;
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
