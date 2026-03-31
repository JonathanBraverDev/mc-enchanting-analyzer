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

        for (const ml of levels) {
            if (signal?.aborted) throw new Error("Aborted");

            const mProb = modDist[ml];
            const searchLimit = getSearchLimit(cat, threshold, maxIterations);
            
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
