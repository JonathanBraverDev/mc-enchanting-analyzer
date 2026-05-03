import { ProbUtils, ComboUtils } from '#utils/index.js';
import { ENGINE_LIMITS, PACKING_CONSTANTS } from '#constants/engine.js';
import { CalculationStats, ConditionedSummaryRequest, PackedCombo, SearchFrontierSnapshot, SummaryRequest } from '#types/index.js';
import { ClueAnalysisService } from '#services/ClueAnalysisService.js';

/**
 * Service for summarizing search results into a standard JSON format.
 */
export class SummaryService {
    /**
     * Summarizes search results into a CalculationStats object.
     */
    public static summarize(request: SummaryRequest): CalculationStats {
        const {
            combos,
            tracker,
            indexToEnchant,
            comboLimit = ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
            threshold = 0,
            frontiers = [],
            isBook = false
        } = request;
        const accounting = tracker.mass.toPublic();
        const stats: CalculationStats = {
            ranks: {},
            any: {},
            count: {},
            combos: {},
            clues: {},
            threshold,
            accuracy: accounting.resolved,
            accounting
        };

        const derived = this.deriveAggregateMasses(combos, indexToEnchant, frontiers, isBook);

        SummaryService.populateStats(stats.any, derived.any);
        SummaryService.populateStats(stats.ranks, derived.ranks);
        SummaryService.populateStats(stats.count, derived.count);

        const clueMass = ClueAnalysisService.calculateClueMass(combos, indexToEnchant, frontiers);
        SummaryService.populateStats(stats.clues, clueMass);

        // Ensure we always return sorted results if a limit is set > 0
        let comboSource: Iterable<[number, bigint]> = [];
        const compareProbDesc = (a: [any, bigint], b: [any, bigint]) => {
            if (a[1] !== b[1]) return a[1] > b[1] ? -1 : 1;
            return a[0] < b[0] ? 1 : (a[0] > b[0] ? -1 : 0);
        };

        if (comboLimit > 0) {
            if (combos.size <= comboLimit) {
                comboSource = [...combos.entries()].sort(compareProbDesc);
            } else if (comboLimit <= 250) {
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
     * @param tracker Original search manager (for metadata).
     * @param indexToEnchant Registry mapping.
     * @param targetClueId The observed clue ID.
     * @param comboLimit Result set limit.
     * @returns Conditioned calculation statistics.
     */
    public static summarizeConditioned(request: ConditionedSummaryRequest): CalculationStats {
        const {
            combos,
            tracker,
            indexToEnchant,
            targetClueId,
            comboLimit = ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
            frontiers = [],
            isBook = false
        } = request;
        // 1. Get honest baseline stats (invariants, absolute accuracy)
        const stats = SummaryService.summarize({ combos, tracker, indexToEnchant, comboLimit: 0, threshold: 0, frontiers, isBook });

        // 2. Perform Bayesian conditioning
        const conditioned = ClueAnalysisService.conditionOnClue(combos, targetClueId, indexToEnchant);

        // 3. Update top-level accuracy and inject absolute clue mass
        stats.accounting.clueKnownSpace = ProbUtils.toNumber(conditioned.clueKnownSpace);

        // Reset result maps for conditioned population
        stats.any = {};
        stats.ranks = {};
        stats.count = {};
        stats.combos = {};
        stats.clues = {};

        // 4. Populate result maps directly (now normalized to 1.0/100% certainty within the service)
        const populatePlain = (target: Record<string, number>, source: Map<number, bigint>) => {
            for (const [key, prob] of source) {
                target[key] = ProbUtils.toNumber(prob);
            }
        };

        populatePlain(stats.any, conditioned.anyMass);
        populatePlain(stats.ranks, conditioned.rankMass);
        populatePlain(stats.count, conditioned.countMass);

        // 5. Populate and rank conditioned combos
        let comboSource: [number, bigint][] = [];
        const compareProbDesc = (a: [any, bigint], b: [any, bigint]) => {
            if (a[1] !== b[1]) return a[1] > b[1] ? -1 : 1;
            return a[0] < b[0] ? 1 : (a[0] > b[0] ? -1 : 0);
        };

        if (comboLimit > 0) {
            comboSource = [...conditioned.combos.entries()].sort(compareProbDesc);
            if (comboSource.length > comboLimit) {
                comboSource = comboSource.slice(0, comboLimit);
            }
        }

        for (const [packed, probBig] of comboSource) {
            stats.combos[packed.toString(16)] = ProbUtils.toNumber(probBig);
        }

        return stats;
    }

    public static deriveAggregateMasses(
        combos: Map<PackedCombo, bigint>,
        indexToEnchant: number[],
        frontiers: SearchFrontierSnapshot[] = [],
        isBook: boolean = false
    ): { any: bigint[]; ranks: bigint[]; count: bigint[] } {
        const any: bigint[] = [];
        const ranks: bigint[] = [];
        const count: bigint[] = [];

        // 1. Add terminal combinations
        for (const [packed, mass] of combos) {
            const n = ComboUtils.getCount(packed);
            count[n] = (count[n] ?? 0n) + mass;

            ComboUtils.forEachEnchant(packed, indexToEnchant, e => {
                const id = e >> PACKING_CONSTANTS.ENCHANT_SHIFT;
                any[id] = (any[id] ?? 0n) + mass;
                ranks[e] = (ranks[e] ?? 0n) + mass;
            });
        }

        // 2. Add pending mass from frontiers
        for (const { frontier, graph, scale } of frontiers) {
            frontier.forEachNode((nodeId, prob) => {
                const mass = ProbUtils.scale(prob, scale);
                const packed = graph.getCombo(nodeId);

                // Count mass (pending nodes contribute to their current count)
                // For books, if count > 1, it will eventually be reduced by 1 upon settling.
                let n = ComboUtils.getCount(packed as PackedCombo);
                let anyScaleNum = 1n;
                let anyScaleDen = 1n;

                if (isBook && n > 1) {
                    anyScaleNum = BigInt(n - 1);
                    anyScaleDen = BigInt(n);
                    n--;
                }

                count[n] = (count[n] ?? 0n) + mass;
                const finalMass = anyScaleDen === 1n ? mass : (mass * anyScaleNum) / anyScaleDen;

                ComboUtils.forEachEnchant(packed as PackedCombo, indexToEnchant, e => {
                    const id = e >> PACKING_CONSTANTS.ENCHANT_SHIFT;
                    any[id] = (any[id] ?? 0n) + finalMass;
                    ranks[e] = (ranks[e] ?? 0n) + finalMass;
                });
            });
        }

        return { any, ranks, count };
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
