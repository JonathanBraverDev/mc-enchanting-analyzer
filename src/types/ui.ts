import { EnchantInsights } from './engine.js';

/**
 * Single data point in a level sweep (e.g., for charting).
 */
export interface SweepData {
    l: number; // XP Level
    s: EnchantInsights; // Statistical summary using consistent insights model
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
