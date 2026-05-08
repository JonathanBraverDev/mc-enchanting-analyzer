import { SEARCH_CONSTANTS } from '#constants/engine.js';
import { ProbUtils } from '#utils/index.js';

/**
 * Shared threshold-to-limit lookup used by EnchantEngine search paths.
 * Determines the iteration limit based on the item and target threshold.
 */
export function getSearchLimit(item: string, threshold: number | bigint, maxIterations?: number): number {
    const t = typeof threshold === 'number' ? threshold : ProbUtils.toNumber(threshold);
    if (maxIterations !== undefined) return maxIterations;
    if (item === "book") return SEARCH_CONSTANTS.FALLBACK_LIMIT_BOOK;
    return t < 0.0001 ? SEARCH_CONSTANTS.FALLBACK_LIMIT_HIGH_RES : SEARCH_CONSTANTS.FALLBACK_LIMIT_LOW_RES;
}
