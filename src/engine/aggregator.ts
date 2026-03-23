import { PRECISION, ProbUtils, AsyncUtils, ResultProcessor } from '../utils/index.js';
import { Registry } from '../core/registry.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { CalculationStats } from '../core/types.js';
import { PackedCombo } from '../utils/types.js';
import { DistributionService } from './distribution.js';
import { SearchService, SearchFrontier } from './search.js';

/**
 * Service for aggregating enchantment statistics across multiple modified levels.
 */
export class StatAggregator {
    /**
     * Aggregates all statistics for a given enchantment attempt.
     */
    public static async getFullStats(
        registry: Registry,
        cat: string, 
        xp: number, 
        mat: string, 
        guaranteedFirst: string | null = null, 
        threshold: number = 0.0001,
        signal?: AbortSignal,
        onProgress?: (stats: CalculationStats) => void,
        maxIterations?: number,
        summaryLimit: number = ENGINE_DEFAULTS.MAX_RESULTS_SUMMARY,
        comboCache?: (key: bigint) => SearchFrontier | undefined,
        setComboCache?: (key: bigint, frontier: SearchFrontier) => void,
        getPackedKey?: (threshold: number) => bigint
    ): Promise<CalculationStats> {
        const bThreshold = ProbUtils.toBigInt(threshold);
        const enchantability = registry.getEnchantability(mat, cat);
        const modDist = DistributionService.getModifiedLevelDist(xp, enchantability, registry);
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);

        if (guaranteedFirst && !registry.isEnchantmentAchievable(guaranteedFirst, cat, mat, levels)) {
            return { ranks: {}, any: {}, count: {}, combos: {}, uncertainty: 1.0 };
        }

        const finalCombos = new Map<PackedCombo, bigint>();
        const totalAnyMass = new Map<number, bigint>();
        const totalRankMass = new Map<number, bigint>();
        const totalCountMass = new Map<number, bigint>();

        const activeThreshold = guaranteedFirst ? bThreshold / 10n : bThreshold;

        let processedMProb = 0n;
        let totalUncertainty = 0n;
        let totalPrunedMass = 0n;
        
        let iterCount = 0;

        for (const ml of levels) {
            if (signal?.aborted) throw new Error("Calculation aborted");

            const mProb = modDist[ml];
            
            // Check cache if provided
            let result: SearchFrontier | undefined;
            const searchLimit = maxIterations ?? (cat === "book" ? ENGINE_DEFAULTS.FALLBACK_LIMIT_BOOK : (threshold < 0.0001 ? ENGINE_DEFAULTS.FALLBACK_LIMIT_HIGH_RES : ENGINE_DEFAULTS.FALLBACK_LIMIT_LOW_RES));
            
            // Note: Caching logic is handled by the caller (EnchantEngine) to keep this service pure
            result = SearchService.calculateCombinations(registry, cat, ml, mat, guaranteedFirst, activeThreshold, searchLimit);
            
            for (const [key, prob] of result.results) {
                const totalProb = ProbUtils.scale(prob, mProb);
                finalCombos.set(key, (finalCombos.get(key) || 0n) + totalProb);
            }

            // Accumulate masses from this Modified Level's frontier
            const { anyMass, rankMass, countMass } = result;
            const addMass = (target: Map<number, bigint>, source: Map<number, bigint>) => {
                for (const [id, mass] of source) {
                    target.set(id, (target.get(id) || 0n) + ProbUtils.scale(mass, mProb));
                }
            };

            addMass(totalAnyMass, anyMass);
            addMass(totalRankMass, rankMass);
            addMass(totalCountMass, countMass);

            totalUncertainty += ProbUtils.scale(result.uncertainty, mProb);
            totalPrunedMass += ProbUtils.scale(result.prunedMass, mProb);

            processedMProb += mProb;
            if (++iterCount % 3 === 0) {
                if (onProgress) {
                    onProgress(ResultProcessor.summarize(finalCombos, totalUncertainty + (PRECISION - processedMProb), totalAnyMass, totalRankMass, totalCountMass, 0));
                }
                await AsyncUtils.yield();
            }
        }

        const finalStats = ResultProcessor.summarize(finalCombos, totalUncertainty, totalAnyMass, totalRankMass, totalCountMass, summaryLimit);
        finalStats.pruned = ProbUtils.toNumber(totalPrunedMass);

        return finalStats;
    }
}
