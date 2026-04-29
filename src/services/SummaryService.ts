import { ProbUtils } from '../utils/math/ProbUtils.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { CalculationStats } from '../types/index.js';

/**
 * Service for summarizing raw engine results into a standard JSON format.
 */
export class SummaryService {
    /**
     * Summarizes raw engine results into a CalculationStats object.
     */
    public static summarize(
        combos: Map<number, bigint>,
        uncertainty: bigint,
        roundingError: bigint = 0n,
        anyMass?: Map<number, bigint>,
        rankMass?: Map<number, bigint>,
        countMass?: Map<number, bigint>,
        comboLimit: number = ENGINE_DEFAULTS.MAX_RESULTS_SUMMARY
    ): CalculationStats {
        const stats: CalculationStats = {
            ranks: {},
            any: {},
            count: {},
            combos: {},
            uncertainty: ProbUtils.toNumber(uncertainty),
            roundingError: ProbUtils.toNumber(roundingError)
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
        let comboSource: Iterable<[number, bigint]> = combos;
        if (combos.size > comboLimit) {
            if (comboLimit === 0) {
                comboSource = [];
            } else if (comboLimit <= 200) {
                const results: [number, bigint][] = [];
                for (const entry of combos.entries()) {
                    if (results.length < comboLimit) {
                        results.push(entry);
                        if (results.length === comboLimit) results.sort((a, b) => b[1] < a[1] ? -1 : (b[1] > a[1] ? 1 : 0));
                    } else if (entry[1] > results[results.length - 1][1]) {
                        results[results.length - 1] = entry;
                        results.sort((a, b) => b[1] < a[1] ? -1 : (b[1] > a[1] ? 1 : 0));
                    }
                }
                comboSource = results;
            } else {
                comboSource = [...combos.entries()]
                    .sort((a, b) => b[1] < a[1] ? -1 : (b[1] > a[1] ? 1 : 0))
                    .slice(0, comboLimit);
            }
        }

        for (const [packed, probBig] of comboSource) {
            stats.combos[packed.toString(16)] = ProbUtils.toNumber(probBig);
        }

        return stats;
    }
}
