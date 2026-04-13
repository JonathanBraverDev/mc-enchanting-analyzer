import { PRECISION, ProbUtils, AsyncUtils, ComboUtils, EnchantUtils } from '../utils/index.js';
import { SummaryService } from '../services/index.js';
import { getEnchantability } from '../core/registry.js';
import { ENGINE_LIMITS } from '../constants/engine.js';
import { getSearchLimit } from '../core/config.js';
import { CalculationStats, PackedCombo, SearchFrontier, RegistryState, InternalSearchConfig, EngineInstrumentation, MassCheckpoint, CheckpointSummary } from '../types/index.js';
import { DistributionService } from './distribution.js';
import { SearchService } from './search.js';
import { FrontierFactory } from './frontier.js';
import { ProbabilityMassTracker } from './ProbabilityMassTracker.js';
import { CacheManager } from '../services/CacheManager.js';

/**
 * Service for aggregating enchantment statistics across multiple modified levels.
 */
export class StatAggregator {
    constructor(
        private readonly cache: CacheManager,
        private readonly distributionService: DistributionService,
        private readonly searchService: SearchService
    ) {}

    /**
     * Aggregates statistics across tiers of increasing search depth.
     */
    public async getFullStatsTiered(
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
            summaryLimit = ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_SIZE,
            instrumentation
        } = config;

        const enchantability = getEnchantability(registry, mat, cat);
        const modDist = this.distributionService.getModifiedLevelDist(registry, xp, enchantability, this.cache, instrumentation);
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);

        const frontierMap = new Map<number, SearchFrontier>();
        const initialTracker = new ProbabilityMassTracker();
        initialTracker.record('pending', PRECISION);
        let lastStats: CalculationStats = { ranks: {}, any: {}, count: {}, combos: {}, threshold: 0, accuracy: 0, accounting: initialTracker.toPublic() };

        for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
            if (signal?.aborted) return lastStats;

            const tier = tiers[tierIndex];
            const activeThreshold = ProbUtils.toBigInt(tier.threshold);

            const finalCombos = new Map<PackedCombo, bigint>();
            const totalAnyMass = new BigUint64Array(256);
            const totalRankMass = new BigUint64Array(16384);
            const totalCountMass = new BigUint64Array(16);

            let tierTracker = new ProbabilityMassTracker();

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

                const result = await this.searchService.calculateCombinations(
                    registry, cat, ml, guaranteedFirst,
                    existingFrontier, {
                        threshold: activeThreshold,
                        limit: tier.limit,
                        resultsLimit,
                        signal,
                        instrumentation,
                        timing: config.timing
                    }
                );

                frontierMap.set(ml, result);

                if (instrumentation) {
                    this.updateInstrumentation(instrumentation, result);
                }

                ProbUtils.addMapMass(finalCombos, result.results, mProb);
                ProbUtils.addMapMass(totalAnyMass, result.anyMass, mProb);
                ProbUtils.addMapMass(totalRankMass, result.rankMass, mProb);
                ProbUtils.addMapMass(totalCountMass, result.countMass, mProb);

                tierTracker.addScaled(result.tracker, mProb);

                processedMProb += mProb;
                await AsyncUtils.yield();
            }

            if (abortedMidTier && processedMProb === 0n) return lastStats;

            const distRoundingError = PRECISION - processedMProb;
            tierTracker.record('rounding', distRoundingError);

            if (guaranteedFirst) {
                this.reconcileGuaranteedMass(registry, guaranteedFirst, totalAnyMass, totalRankMass, totalCountMass);
            }

            const tierStats = SummaryService.summarize(finalCombos, tierTracker, totalAnyMass, totalRankMass, totalCountMass, summaryLimit, tier.threshold);
            tierStats.instrumentation = instrumentation ? this.snapshotInstrumentation(instrumentation) : undefined;
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
    public async getFullStats(
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
            summaryLimit = ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_SIZE,
            getExtendedCache,
            setExtendedCache,
            useCache = true,
            instrumentation,
            getCacheMetrics
        } = config;

        const bThreshold = ProbUtils.toBigInt(threshold);
        const enchantability = getEnchantability(registry, mat, cat);
        const modDist = this.distributionService.getModifiedLevelDist(registry, xp, enchantability, this.cache, instrumentation);
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);

        const finalCombos = new Map<PackedCombo, bigint>();
        const totalAnyMass = new BigUint64Array(256);
        const totalRankMass = new BigUint64Array(16384);
        const totalCountMass = new BigUint64Array(16);

        let globalTracker = new ProbabilityMassTracker();

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
            if (instrumentation && getExtendedCache) {
                const metrics = this.cache.getEngineMetrics().frontierCache;
                instrumentation.frontierCache = metrics;
            }

            const result = await this.searchService.calculateCombinations(
                registry, cat, ml, guaranteedFirst,
                cached, {
                    threshold: bThreshold,
                    limit,
                    resultsLimit,
                    signal,
                    instrumentation,
                    timing: config.timing
                }
            );

            if (instrumentation) {
                this.updateInstrumentation(instrumentation, result);
                if (instrumentation.trackGlobalMetrics && getCacheMetrics) {
                    instrumentation.globalResultsSize = finalCombos.size;
                    const metrics = getCacheMetrics() as any;
                    instrumentation.globalCacheNodes = metrics.cacheNodes;
                    instrumentation.globalCacheResults = metrics.cacheResults;
                }
            }

            if (useCache && setExtendedCache) setExtendedCache(ml, result);

            ProbUtils.addMapMass(finalCombos, result.results, mProb);
            ProbUtils.addMapMass(totalAnyMass, result.anyMass, mProb);
            ProbUtils.addMapMass(totalRankMass, result.rankMass, mProb);
            ProbUtils.addMapMass(totalCountMass, result.countMass, mProb);

            globalTracker.addScaled(result.tracker, mProb);

            processedMProb += mProb;
            if (++iterCount % 3 === 0) {
                if (onProgress) {
                    const partialStats = SummaryService.summarize(finalCombos, globalTracker, totalAnyMass, totalRankMass, totalCountMass, 0, threshold);
                    partialStats.instrumentation = instrumentation ? this.snapshotInstrumentation(instrumentation) : undefined;
                    partialStats.timing = config.timing ? { ...config.timing } : undefined;
                    onProgress(partialStats);
                }
                await AsyncUtils.yield();
            }
        }

        const distRoundingError = PRECISION - processedMProb;
        globalTracker.record('rounding', distRoundingError);

        if (guaranteedFirst) {
            this.reconcileGuaranteedMass(registry, guaranteedFirst, totalAnyMass, totalRankMass, totalCountMass);
        }

        const finalStats = SummaryService.summarize(finalCombos, globalTracker, totalAnyMass, totalRankMass, totalCountMass, summaryLimit, threshold);
        finalStats.instrumentation = instrumentation ? this.snapshotInstrumentation(instrumentation) : undefined;
        finalStats.timing = config.timing ? { ...config.timing } : undefined;

        return finalStats;
    }

    private updateInstrumentation(instr: EngineInstrumentation, result: SearchFrontier): void {
        instr.checkpoints = instr.checkpoints || [];
        if (result.checkpoints) {
            for (const cp of result.checkpoints) {
                instr.checkpoints.push({ 
                    ...cp, 
                    totalIterations: (instr.totalIterations || 0) + cp.iterations 
                });
            }
        }
        instr.totalIterations = (instr.totalIterations || 0) + result.iterations;
        instr.exitReason = result.exitReason;
        instr.levelsProcessed = (instr.levelsProcessed || 0) + 1;
        if (result.exitReason === 'empty') instr.levelsFullyResolved = (instr.levelsFullyResolved || 0) + 1;
        instr.fullyResolved = instr.levelsFullyResolved === instr.levelsProcessed;
        
        // Update cache performance metrics
        const metrics = this.cache.getEngineMetrics();
        instr.poolCache = metrics.poolCache;
        instr.distCache = metrics.distCache;
        instr.frontierCache = metrics.frontierCache;
    }

    /** Build a checkpointSummary from the raw flat checkpoints array. */
    private buildCheckpointSummary(checkpoints: MassCheckpoint[]): CheckpointSummary[] {
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

    private snapshotInstrumentation(instr: EngineInstrumentation): EngineInstrumentation {
        const checkpoints = [...instr.checkpoints];
        const checkpointSummary = this.buildCheckpointSummary(checkpoints);
        instr.checkpointSummary = checkpointSummary;
        return { ...instr, checkpoints, checkpointSummary };
    }

    private reconcileGuaranteedMass(
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
            totalAnyMass[gId] = PRECISION;
            const fullId = (gId << 8) | (parsed?.rank ?? 1);
            totalRankMass[fullId] = PRECISION;
        }
    }
}
