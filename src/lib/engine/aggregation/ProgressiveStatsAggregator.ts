import { PRECISION, ProbUtils, AsyncUtils } from '#utils/index.js';
import { getEnchantability } from '#core/registry.js';
import { ENGINE_LIMITS, PACKING_CONSTANTS, SEARCH_CONSTANTS, UI_CONSTANTS } from '#constants/engine.js';
import { getSearchLimit } from '../utils.js';
import { PackedCombo, SearchState, RegistryState, InternalSearchConfig, EngineInstrumentation, MassCheckpoint, CheckpointSummary, AggregationResult } from '#types/index.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchService } from '#engine/search/SearchService.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { CacheManager } from '#engine/cache/CacheManager.js';

/**
 * Service for aggregating enchantment statistics across multiple modified levels.
 */
export class ProgressiveStatsAggregator {
    constructor(
        private readonly cache: CacheManager,
        private readonly distributionService: ModifiedLevelDistributionService,
        private readonly searchService: SearchService
    ) {}

    /**
     * Aggregates statistics across tiers of increasing search depth.
     * This is the orchestrator for progressive refinement, reusing previous tiers'
     * results and search states to efficiently deepen the calculation.
     * 
     * @param registry Resolved registry state.
     * @param cat Item category.
     * @param xp Base XP level.
     * @param mat Item material.
     * @param tiers Array of (threshold, limit) configs for each pass.
     * @param onTierComplete Callback fired with results after each tier.
     * @param config Internal search configuration.
     * @returns The final aggregated result from the last tier.
     */
    public async calculateTiered(
        registry: RegistryState,
        cat: string,
        xp: number,
        mat: string,
        tiers: Array<{ threshold: number; limit: number }>,
        onTierComplete: (result: AggregationResult, tierIndex: number) => void,
        config: InternalSearchConfig
    ): Promise<AggregationResult> {
        const {
            signal,
            instrumentation
        } = config;

        const enchantability = getEnchantability(registry, mat, cat);
        const modDist = this.distributionService.getModifiedLevelDist(registry, xp, enchantability, this.cache, instrumentation);
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);

        const stateMap = new Map<number, SearchState>();
        const initialTracker = new SearchStateTracker();
        initialTracker.record('pending', PRECISION);
        
        let lastResult: AggregationResult = {
            combos: new Map(),
            tracker: initialTracker,
            anyMass: new BigUint64Array(PACKING_CONSTANTS.BYTE_BASIS),
            rankMass: new BigUint64Array(PACKING_CONSTANTS.MAX_RANKED_INDEX),
            countMass: new BigUint64Array(PACKING_CONSTANTS.MAX_COUNT_INDEX),
            threshold: 0
        };

        for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
            if (signal?.aborted) return lastResult;

            const tier = tiers[tierIndex];
            if (tier === undefined) continue;
            const activeThreshold = ProbUtils.toBigInt(tier.threshold);

            const finalCombos = new Map<PackedCombo, bigint>();
            const totalAnyMass = new BigUint64Array(PACKING_CONSTANTS.BYTE_BASIS);
            const totalRankMass = new BigUint64Array(PACKING_CONSTANTS.MAX_RANKED_INDEX);
            const totalCountMass = new BigUint64Array(PACKING_CONSTANTS.MAX_COUNT_INDEX);
            let tierTracker = new SearchStateTracker();

            let processedMProb = 0n;
            let abortedMidTier = false;

            for (const ml of levels) {
                if (signal?.aborted) {
                    if (instrumentation) instrumentation.exitReason = 'aborted';
                    abortedMidTier = true;
                    break;
                }

                const mProb = modDist[ml];
                if (mProb === undefined) continue;
                const existingState = stateMap.get(ml);

                const result = await this.searchService.search(
                    registry, cat, ml,
                    existingState, {
                        threshold: activeThreshold,
                        limit: tier.limit,
                        resultsLimit: config.resultsLimit ?? ENGINE_LIMITS.MAX_RESULTS_SIZE,
                        signal,
                        instrumentation,
                        timing: config.timing
                    }
                );

                stateMap.set(ml, result);

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

            if (abortedMidTier && processedMProb === 0n) return lastResult;

            const distRoundingError = PRECISION - processedMProb;
            tierTracker.record('rounding', distRoundingError);


            const tierResult: AggregationResult = {
                combos: finalCombos,
                tracker: tierTracker,
                anyMass: totalAnyMass,
                rankMass: totalRankMass,
                countMass: totalCountMass,
                instrumentation: instrumentation ? this.snapshotInstrumentation(instrumentation) : undefined,
                timing: config.timing ? { ...config.timing } : undefined,
                threshold: tier.threshold
            };

            if (abortedMidTier) return tierResult;

            onTierComplete(tierResult, tierIndex);
            lastResult = tierResult;
        }

        return lastResult;
    }

    /**
     * Performs a single-pass aggregation for the given XP level.
     * Aggregates mass from the probability distribution of modified levels
     * into global any/rank/count counters.
     * 
     * @param registry Resolved registry state.
     * @param cat Item category.
     * @param xp Base XP level.
     * @param mat Item material.
     * @param config Internal search configuration.
     */
    public async calculate(
        registry: RegistryState,
        cat: string,
        xp: number,
        mat: string,
        config: InternalSearchConfig = {}
    ): Promise<AggregationResult> {
        const {
            threshold = ENGINE_LIMITS.DEFAULT_THRESHOLD,
            signal,
            maxIterations,
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
        const totalAnyMass = new BigUint64Array(PACKING_CONSTANTS.BYTE_BASIS);
        const totalRankMass = new BigUint64Array(PACKING_CONSTANTS.MAX_RANKED_INDEX);
        const totalCountMass = new BigUint64Array(PACKING_CONSTANTS.MAX_COUNT_INDEX);
        let globalTracker = new SearchStateTracker();

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
            if (mProb === undefined) continue;
            const cached = getExtendedCache?.(ml);
            if (instrumentation && getExtendedCache) {
                const metrics = this.cache.getEngineMetrics().frontierCache;
                instrumentation.frontierCache = metrics;
            }

            const result = await this.searchService.search(
                registry, cat, ml,
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
            if (++iterCount % UI_CONSTANTS.PROGRESS_UPDATE_FREQUENCY === 0) {
                if (config.onProgress) {
                    const accuracy = globalTracker.toPublic().resolved;
                    config.onProgress({
                        processed: iterCount,
                        total: levels.length,
                        accuracy
                    });
                }
                await AsyncUtils.yield();
            }
        }

        const distRoundingError = PRECISION - processedMProb;
        globalTracker.record('rounding', distRoundingError);


        return {
            combos: finalCombos,
            tracker: globalTracker,
            anyMass: totalAnyMass,
            rankMass: totalRankMass,
            countMass: totalCountMass,
            instrumentation: instrumentation ? this.snapshotInstrumentation(instrumentation) : undefined,
            timing: config.timing ? { ...config.timing } : undefined,
            threshold: ProbUtils.toNumber(threshold)
        };
    }

    private updateInstrumentation(instr: EngineInstrumentation, state: SearchState): void {
        instr.checkpoints = instr.checkpoints || [];
        if (state.checkpoints) {
            for (const cp of state.checkpoints) {
                instr.checkpoints.push({ 
                    ...cp, 
                    totalIterations: (instr.totalIterations || 0) + cp.iterations 
                });
            }
        }
        instr.totalIterations = (instr.totalIterations || 0) + state.iterations;
        instr.exitReason = state.exitReason;
        instr.levelsProcessed = (instr.levelsProcessed || 0) + 1;
        if (state.exitReason === 'empty') instr.levelsFullyResolved = (instr.levelsFullyResolved || 0) + 1;
        instr.fullyResolved = instr.levelsFullyResolved === instr.levelsProcessed;
        
        // Update cache performance metrics
        const metrics = this.cache.getEngineMetrics();
        instr.poolCache = metrics.poolCache;
        instr.distCache = metrics.distCache;
        instr.frontierCache = metrics.frontierCache;
    }

    /** Build a checkpointSummary from the raw flat checkpoints array. */
    private buildCheckpointSummary(checkpoints: MassCheckpoint[]): CheckpointSummary[] {
        const targets = SEARCH_CONSTANTS.CHECKPOINT_TARGET_FLOATS;
        const byTarget = new Map<number, { threshold: number; iterations: number; level: number }[]>();
        for (const target of targets) byTarget.set(target, []);

        for (const cp of checkpoints) {
            let matched: number | null = null;
            for (const t of targets) {
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
        for (const target of targets) {
            const entries = byTarget.get(target)!;
            if (entries.length === 0) continue;
            const first = entries[0];
            if (first === undefined) continue;
            const bottleneck = entries.reduce((worst, e) => e.threshold < worst.threshold ? e : worst, first);
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
}
