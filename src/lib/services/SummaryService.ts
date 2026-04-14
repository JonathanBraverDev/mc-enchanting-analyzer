import { ProbUtils } from '../utils/math/ProbUtils.js';
import { ENGINE_LIMITS } from '../constants/engine.js';
import { CalculationStats } from '../types/index.js';
import { ProbabilityMassTracker } from '../engine/search/MassAccountant.js';

/**
 * Service for summarizing raw engine results into a standard JSON format.
 */
export class SummaryService {
    /**
     * Summarizes raw engine results into a CalculationStats object.
     */
    public static summarize(
        combos: Map<number, bigint>,
        tracker: ProbabilityMassTracker,
        anyMass?: Map<number, bigint> | BigUint64Array,
        rankMass?: Map<number, bigint> | BigUint64Array,
        countMass?: Map<number, bigint> | BigUint64Array,
        comboLimit: number = ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
        threshold: number = 0
    ): CalculationStats {
        const accounting = tracker.toPublic();
        const stats: CalculationStats = {
            ranks: {},
            any: {},
            count: {},
            combos: {},
            threshold,
            accuracy: accounting.resolved,
            accounting
        };

        if (anyMass) SummaryService.populateStats(stats.any, anyMass);
        if (rankMass) SummaryService.populateStats(stats.ranks, rankMass);
        if (countMass) SummaryService.populateStats(stats.count, countMass);

        // Ensure we always return sorted results if a limit is set > 0
        let comboSource: Iterable<[number, bigint]> = [];
        const compareProbDesc = (a: [any, bigint], b: [any, bigint]) => {
            if (a[1] !== b[1]) return a[1] > b[1] ? -1 : 1;
            return a[0] < b[0] ? 1 : (a[0] > b[0] ? -1 : 0);
        };

        if (comboLimit > 0) {
            if (combos.size <= comboLimit) {
                comboSource = [...combos.entries()].sort(compareProbDesc);
            } else if (comboLimit <= 250) { // Using absolute number instead of soft-coded limit for simplicity
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
                comboSource = [...combos.entries()].sort(compareProbDesc).slice(0, comboLimit);
            }
        }

        for (const [packed, probBig] of comboSource) {
            stats.combos[packed.toString(16)] = ProbUtils.toNumber(probBig);
        }

        return stats;
    }

    private static populateStats(target: { [key: number]: number }, source: Map<number, bigint> | BigUint64Array): void {
        if (source instanceof BigUint64Array) {
            for (let i = 0; i < source.length; i++) {
                const mass = source[i];
                if (mass > 0n) {
                    target[i] = ProbUtils.toNumber(mass);
                }
            }
        } else {
            for (const [id, mass] of source) {
                target[id] = ProbUtils.toNumber(mass);
            }
        }
    }
}
