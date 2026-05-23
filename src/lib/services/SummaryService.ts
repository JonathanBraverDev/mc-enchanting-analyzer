import { ProbUtils } from '#utils/index.js';
import { ENGINE_LIMITS, SEARCH_CONSTANTS } from '#constants/engine.js';
import { EnchantStats, ConditionedSummaryRequest, SummaryRequest } from '#types/index.js';
import { ClueAnalysisService } from '#services/ClueAnalysisService.js';
import { SummaryAggregationService } from '#services/SummaryAggregationService.js';
import { getMaterializedFrontierEntries } from '#lib/search/SearchRun.js';

/**
 * Service for summarizing search results into a standard JSON format.
 */
export class SummaryService {
    /**
     * Summarizes search results into a EnchantStats object.
     */
    public static summarize(request: SummaryRequest): EnchantStats {
        const {
            combos,
            snapshot,
            indexToEnchant,
            threshold = 0,
            isBook = false
        } = request;
        const comboLimit = this.resolveComboLimit(request.comboLimit, request.uncappedResults);
        const accounting = snapshot.mass;
        const stats: EnchantStats = {
            ranks: {},
            any: {},
            count: {},
            combos: {},
            shownClueDistribution: {},
            threshold,
            accuracy: accounting.resolved + accounting.clueIncompatible,
            accounting
        };

        const derived = SummaryAggregationService.aggregate({
            combos,
            indexToEnchant,
            frontier: snapshot.frontier,
            isBook
        });

        SummaryService.populateStats(stats.any, derived.any);
        SummaryService.populateStats(stats.ranks, derived.ranks);
        SummaryService.populateStats(stats.count, derived.count);
        SummaryService.populateStats(stats.shownClueDistribution!, derived.shownClueDistribution);

        // Ensure exported combo results are sorted and capped unless explicitly uncapped.
        let comboSource: Iterable<[number, bigint]> = [];
        const compareProbDesc = (a: [any, bigint], b: [any, bigint]) => {
            if (a[1] !== b[1]) return a[1] > b[1] ? -1 : 1;
            return a[0] < b[0] ? 1 : (a[0] > b[0] ? -1 : 0);
        };

        if (comboLimit === undefined || comboLimit > 0) {
            if (comboLimit === undefined || combos.size <= comboLimit) {
                comboSource = [...combos.entries()].sort(compareProbDesc);
            } else if (comboLimit <= SEARCH_CONSTANTS.MAX_RESULTS_SUMMARY_OPTIMIZED_THRESHOLD) {
                const results: [number, bigint][] = [];
                for (const entry of combos.entries()) {
                    const prob = entry[1];
                    const lastEntry = results[results.length - 1];
                    if (results.length < comboLimit || (lastEntry !== undefined && prob > lastEntry[1])) {
                        let low = 0, high = results.length;
                        while (low < high) {
                            const mid = (low + high) >>> 1;
                            const midEntry = results[mid];
                            if (midEntry !== undefined && midEntry[1] < prob) high = mid;
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

    /**
     * Summarizes statistics under the condition that a specific clue is shown.
     *
     * @param combos Combination distribution before clue conditioning.
     * @param indexToEnchant Registry mapping.
     * @param targetClueId The observed clue ID.
     * @param comboLimit Result set limit; values above the normal export cap require uncappedResults.
     * @returns Conditioned enchant stats.
     */
    public static summarizeConditioned(request: ConditionedSummaryRequest): EnchantStats {
        const {
            combos,
            snapshot,
            indexToEnchant,
            targetClueId
        } = request;
        const comboLimit = this.resolveComboLimit(request.comboLimit, request.uncappedResults);
        const accounting = snapshot.mass;
        const stats: EnchantStats = {
            ranks: {},
            any: {},
            count: {},
            combos: {},
            threshold: 0,
            accuracy: accounting.resolved + accounting.clueIncompatible,
            accounting
        };

        // 1. Perform Bayesian conditioning
        const conditioned = ClueAnalysisService.conditionOnClue(
            combos,
            targetClueId,
            indexToEnchant,
            request.isBook ?? false,
            getMaterializedFrontierEntries(snapshot.frontier),
            snapshot.frontier
        );

        // 2. Preserve observed-clue diagnostics used for Bayesian conditioning.
        stats.clue = {
            idAndRank: targetClueId,
            knownSpace: ProbUtils.toNumber(conditioned.knownSpace)
        };

        // 3. Populate result maps directly (now normalized to 1.0/100% certainty within the service)
        const populatePlain = (target: Record<string, number>, source: Map<number, bigint>) => {
            for (const [key, prob] of source) {
                target[key] = ProbUtils.toNumber(prob);
            }
        };

        populatePlain(stats.any, conditioned.anyMass);
        populatePlain(stats.ranks, conditioned.rankMass);
        populatePlain(stats.count, conditioned.countMass);

        // 4. Populate and rank conditioned combos
        let comboSource: [number, bigint][] = [];
        const compareProbDesc = (a: [any, bigint], b: [any, bigint]) => {
            if (a[1] !== b[1]) return a[1] > b[1] ? -1 : 1;
            return a[0] < b[0] ? 1 : (a[0] > b[0] ? -1 : 0);
        };

        if (comboLimit === undefined || comboLimit > 0) {
            comboSource = [...conditioned.combos.entries()].sort(compareProbDesc);
            if (comboLimit !== undefined && comboSource.length > comboLimit) {
                comboSource = comboSource.slice(0, comboLimit);
            }
        }

        for (const [packed, probBig] of comboSource) {
            stats.combos[packed.toString(16)] = ProbUtils.toNumber(probBig);
        }

        return stats;
    }

    private static resolveComboLimit(comboLimit: number | undefined, uncappedResults: boolean | undefined): number | undefined {
        if (comboLimit !== undefined) {
            if (!Number.isInteger(comboLimit) || comboLimit < 0) {
                throw new Error(`Invalid comboLimit: ${comboLimit}. Must be a non-negative integer.`);
            }
            if (!uncappedResults && comboLimit > ENGINE_LIMITS.RESULT_ENTRY_SAFETY_CAP) {
                throw new Error(`Invalid comboLimit: ${comboLimit}. Must be <= ${ENGINE_LIMITS.RESULT_ENTRY_SAFETY_CAP}, or set uncappedResults: true.`);
            }
            return comboLimit;
        }
        return uncappedResults ? undefined : ENGINE_LIMITS.MAX_RESULTS_SUMMARY;
    }

    private static populateStats(target: { [key: number]: number }, source: Map<number, bigint> | BigUint64Array | bigint[]): void {
        if (Array.isArray(source)) {
            for (let i = 0; i < source.length; i++) {
                const val = source[i];
                if (val !== undefined && val > 0n) {
                    target[i] = ProbUtils.toNumber(val);
                }
            }
        } else if (source instanceof BigUint64Array) {
            for (const [i, mass] of source.entries()) {
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
