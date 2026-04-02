import { PRECISION, ProbUtils, AsyncUtils, ComboUtils, EnchantUtils } from '../utils/index.js';
import { SummaryService } from '../services/index.js';
import { getEnchantability, isEnchantmentAchievable } from '../core/registry.js';
import { ENGINE_DEFAULTS, getSearchLimit } from '../core/config.js';
import { CalculationStats, PackedCombo, SearchFrontier, RegistryState, InternalSearchConfig } from '../types/index.js';
import { DistributionService } from './distribution.js';
import { SearchService } from './search.js';
import { FrontierFactory } from './frontier.js';

/**
 * Service for aggregating enchantment statistics across multiple modified levels.
 */
export class StatAggregator {
    private static addMass(target: Map<number, bigint>, source: Map<number, bigint>, mProb: bigint): void {
        for (const [id, mass] of source) {
            target.set(id, (target.get(id) || 0n) + ProbUtils.scale(mass, mProb));
        }
    }
    /**
     * Aggregates statistics across tiers of increasing search depth.
     *
     * Runs each tier's search over all modified levels, resuming each level's frontier
     * from where the previous tier left off. Calls onTierComplete after every tier
     * completes. Returns the final (deepest) tier's stats.
     */
    public static async getFullStatsTiered(
        registry: RegistryState,
        cat: string,
        xp: number,
        mat: string,
        guaranteedFirst: string | null,
        tiers: Array<{ threshold: number; limit: number }>,
        onTierComplete: (stats: CalculationStats, tierIndex: number) => void,
        config: InternalSearchConfig
    ): Promise<CalculationStats> {
        const {
            signal,
            summaryLimit = ENGINE_DEFAULTS.MAX_RESULTS_SUMMARY,
            resultsLimit = ENGINE_DEFAULTS.MAX_RESULTS_SIZE,
            distCache,
            poolCache
        } = config;

        const enchantability = getEnchantability(registry, mat, cat);
        const modDist = DistributionService.getModifiedLevelDist(xp, enchantability, registry, distCache);
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);

        if (guaranteedFirst && !isEnchantmentAchievable(registry, guaranteedFirst, cat, mat, levels, poolCache)) {
            return { ranks: {}, any: {}, count: {}, combos: {}, uncertainty: 1.0 };
        }

        // Local frontier map — persists across tiers, not stored in the LRU cache
        const frontierMap = new Map<number, SearchFrontier>();

        let lastStats: CalculationStats = { ranks: {}, any: {}, count: {}, combos: {}, uncertainty: 1.0 };

        for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
            // Between tiers: return best result so far instead of throwing
            if (signal?.aborted) return lastStats;

            const tier = tiers[tierIndex];
            const bThreshold = ProbUtils.toBigInt(tier.threshold);
            const activeThreshold = guaranteedFirst ? bThreshold / 10n : bThreshold;

            const finalCombos = new Map<PackedCombo, bigint>();
            const totalAnyMass = new Map<number, bigint>();
            const totalRankMass = new Map<number, bigint>();
            const totalCountMass = new Map<number, bigint>();

            let processedMProb = 0n;
            let totalUncertainty = 0n;
            let totalPrunedMass = 0n;
            let totalRoundingError = 0n;

            let abortedMidTier = false;
            for (const ml of levels) {
                // Between modified levels: save partial work instead of throwing
                if (signal?.aborted) {
                    abortedMidTier = true;
                    break;
                }

                const mProb = modDist[ml];
                const existingFrontier = frontierMap.get(ml);

                const result = SearchService.calculateCombinations(
                    registry, cat, ml, mat, guaranteedFirst,
                    activeThreshold, tier.limit,
                    existingFrontier, resultsLimit, poolCache
                );

                frontierMap.set(ml, result);

                for (const [key, prob] of result.results) {
                    const totalProb = ProbUtils.scale(prob, mProb);
                    finalCombos.set(key, (finalCombos.get(key) || 0n) + totalProb);
                }

                StatAggregator.addMass(totalAnyMass, result.anyMass, mProb);
                StatAggregator.addMass(totalRankMass, result.rankMass, mProb);
                StatAggregator.addMass(totalCountMass, result.countMass, mProb);

                totalUncertainty += ProbUtils.scale(result.uncertainty, mProb);
                totalPrunedMass += ProbUtils.scale(result.prunedMass, mProb);
                totalRoundingError += ProbUtils.scale(result.roundingError, mProb);

                processedMProb += mProb;
                await AsyncUtils.yield();
            }

            // Aborted before any level was processed — return previous tier's result
            if (abortedMidTier && processedMProb === 0n) return lastStats;

            const distRoundingError = PRECISION - processedMProb;
            totalRoundingError += distRoundingError;

            if (guaranteedFirst) {
                const romanMap = registry.data.constants.ROMAN_MAP;
                const parsed = EnchantUtils.parse(guaranteedFirst, romanMap);
                const gId = parsed ? registry.idMap.get(parsed.name) : undefined;

                if (gId !== undefined) {
                    totalAnyMass.set(gId, (totalAnyMass.get(gId) || 0n) + distRoundingError);

                    const fullId = (gId << 8) | (parsed?.rank ?? 1);
                    totalRankMass.set(fullId, (totalRankMass.get(fullId) || 0n) + distRoundingError);

                    totalCountMass.set(1, (totalCountMass.get(1) || 0n) + distRoundingError);
                }
            }

            const tierStats = SummaryService.summarize(finalCombos, totalUncertainty, totalRoundingError, totalAnyMass, totalRankMass, totalCountMass, summaryLimit);
            tierStats.pruned = ProbUtils.toNumber(totalPrunedMass);

            // Aborted mid-tier: return summarized partial result, skip onTierComplete
            if (abortedMidTier) return tierStats;

            onTierComplete(tierStats, tierIndex);
            lastStats = tierStats;
        }

        return lastStats;
    }

    /**
     * Aggregates all statistics for a given enchantment attempt.
     */
    public static async getFullStats(
        registry: RegistryState,
        cat: string,
        xp: number,
        mat: string,
        guaranteedFirst: string | null = null,
        config: InternalSearchConfig = {}
    ): Promise<CalculationStats> {
        const {
            threshold = 0.0001,
            signal,
            onProgress,
            maxIterations,
            summaryLimit = ENGINE_DEFAULTS.MAX_RESULTS_SUMMARY,
            resultsLimit = ENGINE_DEFAULTS.MAX_RESULTS_SIZE,
            getExtendedCache,
            setExtendedCache,
            useCache = true,
            distCache,
            poolCache
        } = config;
        const bThreshold = ProbUtils.toBigInt(threshold);
        const enchantability = getEnchantability(registry, mat, cat);
        const modDist = DistributionService.getModifiedLevelDist(xp, enchantability, registry, distCache);
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);

        if (guaranteedFirst && !isEnchantmentAchievable(registry, guaranteedFirst, cat, mat, levels, poolCache)) {
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
        let totalRoundingError = 0n;
        
        let iterCount = 0;
        const searchLimit = getSearchLimit(cat, threshold, maxIterations);

        for (const ml of levels) {
            if (signal?.aborted) throw new Error("Aborted");

            const mProb = modDist[ml];

            // Orchestrate search, using cache if provided by EnchantEngine
            const cached = getExtendedCache?.(ml);
            const result = SearchService.calculateCombinations(
                registry, cat, ml, mat, guaranteedFirst, activeThreshold, searchLimit, cached, resultsLimit, poolCache
            );

            if (useCache && setExtendedCache) {
                setExtendedCache(ml, result);
            }

            for (const [key, prob] of result.results) {
                const totalProb = ProbUtils.scale(prob, mProb);
                finalCombos.set(key, (finalCombos.get(key) || 0n) + totalProb);
            }

            // Accumulate masses from this Modified Level's frontier
            const { anyMass, rankMass, countMass } = result;
            StatAggregator.addMass(totalAnyMass, anyMass, mProb);
            StatAggregator.addMass(totalRankMass, rankMass, mProb);
            StatAggregator.addMass(totalCountMass, countMass, mProb);

            totalUncertainty += ProbUtils.scale(result.uncertainty, mProb);
            totalPrunedMass += ProbUtils.scale(result.prunedMass, mProb);
            totalRoundingError += ProbUtils.scale(result.roundingError, mProb);

            processedMProb += mProb;
            if (++iterCount % 3 === 0) {
                if (onProgress) {
                    onProgress(SummaryService.summarize(finalCombos, totalUncertainty + (PRECISION - processedMProb), totalRoundingError, totalAnyMass, totalRankMass, totalCountMass, 0));
                }
                await AsyncUtils.yield();
            }
        }

        const distRoundingError = PRECISION - processedMProb;
        totalRoundingError += distRoundingError;

        if (guaranteedFirst) {
            const romanMap = registry.data.constants.ROMAN_MAP;
            const parsed = EnchantUtils.parse(guaranteedFirst, romanMap);
            const gId = parsed ? registry.idMap.get(parsed.name) : undefined;
            
            if (gId !== undefined) {
                totalAnyMass.set(gId, (totalAnyMass.get(gId) || 0n) + distRoundingError);
                
                const fullId = (gId << 8) | (parsed?.rank ?? 1);
                totalRankMass.set(fullId, (totalRankMass.get(fullId) || 0n) + distRoundingError);
                
                // Also attribute to count 1+ (usually guaranteed starts at 1)
                totalCountMass.set(1, (totalCountMass.get(1) || 0n) + distRoundingError);
            }
        }

        const finalStats = SummaryService.summarize(finalCombos, totalUncertainty, totalRoundingError, totalAnyMass, totalRankMass, totalCountMass, summaryLimit);
        finalStats.pruned = ProbUtils.toNumber(totalPrunedMass);

        return finalStats;
    }
}
