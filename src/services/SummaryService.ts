import { ProbUtils } from '../utils/math/ProbUtils.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { CalculationStats } from '../types/index.js';
import { MassAccountant } from '../engine/MassAccountant.js';

/**
 * Service for summarizing raw engine results into a standard JSON format.
 */
export class SummaryService {
    /**
     * Summarizes raw engine results into a CalculationStats object.
     */
    public static summarize(
        combos: Map<number, bigint>,
        accountant: MassAccountant,
        anyMass?: Map<number, bigint>,
        rankMass?: Map<number, bigint>,
        countMass?: Map<number, bigint>,
        comboLimit: number = ENGINE_DEFAULTS.MAX_RESULTS_SUMMARY
    ): CalculationStats {
        const accounting = accountant.toPublic();
        const stats: CalculationStats = {
            ranks: {},
            any: {},
            count: {},
            combos: {},
            accuracy: accounting.resolved,
            accounting
        };

        if (anyMass) {
            for (const [id, mass] of anyMass) {
                stats.any[id] = ProbUtils.toNumber(mass);
            }
        }
        if (rankMass) {
            for (const [id, mass] of rankMass) {
                stats.ranks[id] = ProbUtils.toNumber(mass);
            }
        }
        if (countMass) {
            for (const [c, mass] of countMass) {
                stats.count[Number(c)] = ProbUtils.toNumber(mass);
            }
        }

        // Limit the number of combinations serialized for transfer
        // Ensure we always return sorted results if a limit is set > 0
        let comboSource: Iterable<[number, bigint]> = [];
        const compareProbDesc = (a: [any, bigint], b: [any, bigint]) => a[1] > b[1] ? -1 : (a[1] < b[1] ? 1 : 0);

        if (comboLimit > 0) {
            if (combos.size <= comboLimit) {
                // Common case: everything fits, just sort the whole collection
                comboSource = [...combos.entries()].sort(compareProbDesc);
            } else if (comboLimit <= ENGINE_DEFAULTS.MAX_RESULTS_SUMMARY_OPTIMIZED_THRESHOLD) {
                // Optimized Path: Top-K selection with Sorted Array + Binary Search insertion (Desc order)
                // Complexity: O(N * (log K + K)) - extremely fast for K <= 250 in V8
                const results: [number, bigint][] = [];
                for (const entry of combos.entries()) {
                    const prob = entry[1];
                    if (results.length < comboLimit || prob > results[results.length - 1][1]) {
                        let low = 0, high = results.length;
                        while (low < high) {
                            const mid = (low + high) >>> 1;
                            if (results[mid][1] < prob) high = mid;
                            else low = mid + 1;
                        }
                        results.splice(low, 0, entry);
                        if (results.length > comboLimit) results.pop();
                    }
                }
                comboSource = results;
            } else {
                // Fallback for large K (e.g. Snapshots or deep ultra mode): Full sort
                // We avoid splice() for large K as O(N*K) would start to hurt
                comboSource = [...combos.entries()].sort(compareProbDesc).slice(0, comboLimit);
            }
        }

        for (const [packed, probBig] of comboSource) {
            stats.combos[packed.toString(16)] = ProbUtils.toNumber(probBig);
        }

        return stats;
    }
}
