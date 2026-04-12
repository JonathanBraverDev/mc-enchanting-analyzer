import { PRECISION, ProbUtils, AsyncUtils, ComboUtils, EnchantUtils } from '../utils/index.js';
import { SummaryService } from '../services/index.js';
import { getEnchantability, isEnchantmentAchievable } from '../core/registry.js';
import { ENGINE_DEFAULTS, getSearchLimit } from '../core/config.js';
import { CalculationStats, PackedCombo, SearchFrontier, RegistryState, InternalSearchConfig, EngineInstrumentation, MassCheckpoint, CheckpointSummary } from '../types/index.js';
import { DistributionService } from './distribution.js';
import { SearchService } from './search.js';
import { FrontierFactory } from './frontier.js';
import { MassAccountant } from './MassAccountant.js';

/** Build a checkpointSummary from the raw flat checkpoints array. */
function buildCheckpointSummary(checkpoints: MassCheckpoint[]): CheckpointSummary[] {
    const TARGETS = [0.1, 0.25, 0.5, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99, 0.999];
    const byTarget = new Map<number, { threshold: number; iterations: number; level: number }[]>();
    for (const target of TARGETS) byTarget.set(target, []);

    for (const cp of checkpoints) {
        let matched: number | null = null;
        for (const t of TARGETS) {
            if (cp.mass >= t - 0.001) matched = t;
        }
        if (matched !== null) {
            const existing = byTarget.get(matched)!;
            if (!existing.some(e => e.level === cp.modLevel)) {
                existing.push({ threshold: cp.threshold, iterations: cp.iterations, level: cp.modLevel });
            }
        }
    }

    const summary: CheckpointSummary[] = [];
    for (const target of TARGETS) {
        const entries = byTarget.get(target)!;
        if (entries.length === 0) continue;
        const bottleneck = entries.reduce((worst, e) => e.threshold < worst.threshold ? e : worst, entries[0]);
        summary.push({
            target,
            worstCaseThreshold: bottleneck.threshold,
            worstCaseIterations: Math.max(...entries.map(e => e.iterations)),
            bottleneckLevel: bottleneck.level
        });
    }
    return summary;
}

/** Snapshot instrumentation with computed summary. */
function snapshotInstrumentation(instr: EngineInstrumentation): EngineInstrumentation {
    const checkpoints = [...instr.checkpoints];
    const checkpointSummary = buildCheckpointSummary(checkpoints);
    instr.checkpointSummary = checkpointSummary;
    return { ...instr, checkpoints, checkpointSummary };
}

/**
 * Service for aggregating enchantment statistics across multiple modified levels.
 */
export class StatAggregator {

    /**
     * Aggregates statistics across tiers of increasing search depth.
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
            poolCache,
            instrumentation
        } = config;

        const enchantability = getEnchantability(registry, mat, cat);
        const modDist = DistributionService.getModifiedLevelDist(xp, enchantability, registry, distCache);
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);

        const frontierMap = new Map<number, SearchFrontier>();
        const initialAcc = new MassAccountant();
        initialAcc.record('pending', PRECISION);
        let lastStats: CalculationStats = { ranks: {}, any: {}, count: {}, combos: {}, accuracy: 0, accounting: initialAcc.toPublic() };

        for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
            if (signal?.aborted) return lastStats;

            const tier = tiers[tierIndex];
            const finalTier = tiers[tiers.length - 1];
            const activeThreshold = ProbUtils.toBigInt(tier.threshold);
            const activeFloor = ProbUtils.toBigInt(ENGINE_DEFAULTS.SYSTEM_THRESHOLD_FLOOR);

            const finalCombos = new Map<PackedCombo, bigint>();
            const totalAnyMass = new BigUint64Array(256);
            const totalRankMass = new BigUint64Array(16384);
            const totalCountMass = new BigUint64Array(16);

            let tierAccountant = new MassAccountant();

            let processedMProb = 0n;
            let abortedMidTier = false;

            for (const ml of levels) {
                if (signal?.aborted) {
                    if (instrumentation) instrumentation.exitReason = 'aborted';
                    abortedMidTier = true;
                    break;
                }

                const mProb = modDist[ml];
                const existingFrontier = frontierMap.get(ml);

                const result = await SearchService.calculateCombinations(
                    registry, cat, ml, mat, guaranteedFirst,
                    activeThreshold, tier.limit,
                    existingFrontier, resultsLimit, poolCache, signal, instrumentation,
                    activeFloor, config.timing
                );

                frontierMap.set(ml, result);

                if (instrumentation) {
                    instrumentation.checkpoints = instrumentation.checkpoints || [];
                    instrumentation.frontierCache = instrumentation.frontierCache || { hits: 0, misses: 0 };
                    
                    if (result.checkpoints) {
                        for (const cp of result.checkpoints) {
                            instrumentation.checkpoints.push({ 
                                ...cp, 
                                totalIterations: (instrumentation.totalIterations || 0) + cp.iterations 
                            });
                        }
                    }
                    instrumentation.totalIterations = (instrumentation.totalIterations || 0) + result.iterations;
                    instrumentation.exitReason = result.exitReason;
                    instrumentation.levelsProcessed = (instrumentation.levelsProcessed || 0) + 1;
                    if (result.exitReason === 'empty') instrumentation.levelsFullyResolved = (instrumentation.levelsFullyResolved || 0) + 1;
                    instrumentation.fullyResolved = instrumentation.levelsFullyResolved === instrumentation.levelsProcessed;
                }

                ProbUtils.addMapMass(finalCombos, result.results, mProb);
                ProbUtils.addMapMass(totalAnyMass, result.anyMass, mProb);
                ProbUtils.addMapMass(totalRankMass, result.rankMass, mProb);
                ProbUtils.addMapMass(totalCountMass, result.countMass, mProb);

                const levelAcc = new MassAccountant(result.mass);
                tierAccountant.addScaled(levelAcc, mProb);

                processedMProb += mProb;
                await AsyncUtils.yield();
            }

            if (abortedMidTier && processedMProb === 0n) return lastStats;

            const distRoundingError = PRECISION - processedMProb;
            tierAccountant.record('rounding', distRoundingError);

            if (guaranteedFirst) {
                StatAggregator.reconcileGuaranteedMass(
                    registry, guaranteedFirst, totalAnyMass, totalRankMass, totalCountMass
                );
            }

            const tierStats = SummaryService.summarize(finalCombos, tierAccountant, totalAnyMass, totalRankMass, totalCountMass, summaryLimit);
            tierStats.instrumentation = instrumentation ? snapshotInstrumentation(instrumentation) : undefined;
            tierStats.timing = config.timing ? { ...config.timing } : undefined;

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
            poolCache,
            instrumentation,
            getCacheMetrics
        } = config;

        const bThreshold = ProbUtils.toBigInt(threshold);
        const bFloor = ProbUtils.toBigInt(ENGINE_DEFAULTS.SYSTEM_THRESHOLD_FLOOR);
        const enchantability = getEnchantability(registry, mat, cat);
        const modDist = DistributionService.getModifiedLevelDist(xp, enchantability, registry, distCache);
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);

        const finalCombos = new Map<PackedCombo, bigint>();
        const totalAnyMass = new BigUint64Array(256);
        const totalRankMass = new BigUint64Array(16384);
        const totalCountMass = new BigUint64Array(16);

        let globalAccountant = new MassAccountant();

        let processedMProb = 0n;
        let iterCount = 0;
        const limit = getSearchLimit(cat, threshold, maxIterations);

        if (instrumentation) {
            instrumentation.checkpoints = instrumentation.checkpoints || [];
            instrumentation.totalIterations = 0;
            instrumentation.levelsFullyResolved = 0;
            instrumentation.frontierCache = instrumentation.frontierCache || { hits: 0, misses: 0 };
        }

        for (const ml of levels) {
            if (signal?.aborted) throw new Error("Aborted");

            const mProb = modDist[ml];
            const cached = getExtendedCache?.(ml);
            if (instrumentation && getExtendedCache && instrumentation.frontierCache) {
                if (cached) instrumentation.frontierCache.hits++;
                else instrumentation.frontierCache.misses++;
            }

            const result = await SearchService.calculateCombinations(
                registry, cat, ml, mat, guaranteedFirst, bThreshold, limit, cached, resultsLimit, poolCache, signal, instrumentation,
                bFloor, config.timing
            );

            if (instrumentation) {
                if (result.checkpoints && instrumentation.checkpoints) {
                    for (const cp of result.checkpoints) {
                        instrumentation.checkpoints.push({ ...cp, totalIterations: instrumentation.totalIterations + cp.iterations });
                    }
                }
                instrumentation.totalIterations += result.iterations;
                instrumentation.exitReason = result.exitReason;
                instrumentation.levelsProcessed++;
                if (result.exitReason === 'empty') instrumentation.levelsFullyResolved++;
                instrumentation.fullyResolved = instrumentation.levelsFullyResolved === instrumentation.levelsProcessed;
                
                if (instrumentation.trackGlobalMetrics) {
                    instrumentation.globalResultsSize = finalCombos.size;
                    if (getCacheMetrics) {
                        const metrics = getCacheMetrics();
                        instrumentation.globalCacheNodes = metrics.cacheNodes;
                        instrumentation.globalCacheResults = metrics.cacheResults;
                    }
                }
            }

            if (useCache && setExtendedCache) setExtendedCache(ml, result);

            ProbUtils.addMapMass(finalCombos, result.results, mProb);
            ProbUtils.addMapMass(totalAnyMass, result.anyMass, mProb);
            ProbUtils.addMapMass(totalRankMass, result.rankMass, mProb);
            ProbUtils.addMapMass(totalCountMass, result.countMass, mProb);

            const levelAcc = new MassAccountant(result.mass);
            globalAccountant.addScaled(levelAcc, mProb);

            processedMProb += mProb;
            if (++iterCount % 3 === 0) {
                if (onProgress) {
                    const partialStats = SummaryService.summarize(finalCombos, globalAccountant, totalAnyMass, totalRankMass, totalCountMass, 0);
                    partialStats.instrumentation = instrumentation ? snapshotInstrumentation(instrumentation) : undefined;
                    partialStats.timing = config.timing ? { ...config.timing } : undefined;
                    onProgress(partialStats);
                }
                await AsyncUtils.yield();
            }
        }

        const distRoundingError = PRECISION - processedMProb;
        globalAccountant.record('rounding', distRoundingError);

        if (guaranteedFirst) {
            StatAggregator.reconcileGuaranteedMass(
                registry, guaranteedFirst, totalAnyMass, totalRankMass, totalCountMass
            );
        }

        const finalStats = SummaryService.summarize(finalCombos, globalAccountant, totalAnyMass, totalRankMass, totalCountMass, summaryLimit);
        finalStats.instrumentation = instrumentation ? snapshotInstrumentation(instrumentation) : undefined;
        finalStats.timing = config.timing ? { ...config.timing } : undefined;

        return finalStats;
    }

    /**
     * Reconciles all non-pending mass (resolved, sieved, rounding, capped, overflow) 
     * into the guaranteed enchantment's buckets. This ensures exact 1.0 probability 
     * for guarantees without introducing bias elsewhere.
     */
    private static reconcileGuaranteedMass(
        registry: RegistryState,
        guaranteedFirst: string,
        totalAnyMass: BigUint64Array,
        totalRankMass: BigUint64Array,
        totalCountMass: BigUint64Array

    ): void {
        const romanMap = registry.data.constants.ROMAN_MAP;
        const parsed = EnchantUtils.parse(guaranteedFirst, romanMap);
        const gId = parsed ? registry.idMap.get(parsed.name) : undefined;

        if (gId !== undefined) {
            // Reconcile Individual probabilities to absolute 100% (PRECISION).
            // This is mathematically certain because every path in a guaranteed-first search
            // (resolved, sieved, or pending) carries the guaranteed enchantment.
            totalAnyMass[gId] = PRECISION;
            
            const fullId = (gId << 8) | (parsed?.rank ?? 1);
            totalRankMass[fullId] = PRECISION;
        }
    }
}
