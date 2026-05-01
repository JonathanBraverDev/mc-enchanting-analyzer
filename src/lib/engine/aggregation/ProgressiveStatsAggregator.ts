import { PRECISION, ProbUtils, AsyncUtils } from '#utils/index.js';
import { getEnchantability } from '#core/registry.js';
import { ENGINE_LIMITS, UI_CONSTANTS } from '#constants/engine.js';
import { getSearchLimit } from '#engine/utils.js';
import { PackedCombo, SearchState, RegistryState, InternalSearchConfig, EngineInstrumentation, SearchResult } from '#types/index.js';
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
     * Aggregates statistics across checkpoints of increasing search depth.
     * This is the orchestrator for progressive refinement, reusing previous checkpoints'
     * results and search states to efficiently deepen the calculation.
     *
     * @param registry Resolved registry state.
     * @param cat Item category.
     * @param xp Base XP level.
     * @param mat Item material.
     * @param checkpoints Array of (threshold, limit) configs for each pass.
     * @param onCheckpointComplete Callback fired with results after each checkpoint.
     * @param config Internal search configuration.
     * @returns The final aggregated result from the last checkpoint.
     */
    public async searchSequentialCheckpoints(
        registry: RegistryState,
        cat: string,
        xp: number,
        mat: string,
        checkpoints: Array<{ threshold: number; limit: number }>,
        onCheckpointComplete: (result: SearchResult, checkpointIndex: number) => void,
        config: InternalSearchConfig
    ): Promise<SearchResult> {
        const {
            signal,
            instrumentation
        } = config;

        const enchantability = getEnchantability(registry, mat, cat);
        const modDist = this.distributionService.getModifiedLevelDist(registry, xp, enchantability, this.cache, instrumentation);
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);

        const stateMap = new Map<number, SearchState>();
        const initialTracker = new SearchStateTracker();
        initialTracker.mass.record('pending', PRECISION);

        let lastResult: SearchResult = {
            combos: new Map(),
            tracker: initialTracker,
            threshold: 0
        };

        for (let checkpointIndex = 0; checkpointIndex < checkpoints.length; checkpointIndex++) {
            if (signal?.aborted) return lastResult;

            const checkpoint = checkpoints[checkpointIndex];
            if (checkpoint === undefined) continue;
            const activeThreshold = ProbUtils.toBigInt(checkpoint.threshold);

            const finalCombos = new Map<PackedCombo, bigint>();
            let checkpointTracker = new SearchStateTracker();

            let processedMProb = 0n;
            let abortedMidCheckpoint = false;

            for (const ml of levels) {
                if (signal?.aborted) {
                    if (instrumentation) instrumentation.exitReason = 'aborted';
                    abortedMidCheckpoint = true;
                    break;
                }

                const mProb = modDist[ml];
                if (mProb === undefined) continue;
                const existingState = stateMap.get(ml);

                const result = await this.searchService.search(
                    registry, cat, ml,
                    existingState, {
                        threshold: activeThreshold,
                        limit: checkpoint.limit,
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

                checkpointTracker.mass.addScaled(result.tracker.mass, mProb);

                processedMProb += mProb;
                await AsyncUtils.yield();
            }

            const distRoundingError = PRECISION - processedMProb;
            checkpointTracker.mass.record('rounding', distRoundingError);


            const checkpointResult: SearchResult = {
                combos: finalCombos,
                tracker: checkpointTracker,
                instrumentation: instrumentation ? this.snapshotInstrumentation(instrumentation) : undefined,
                timing: config.timing ? { ...config.timing } : undefined,
                threshold: checkpoint.threshold
            };

            if (abortedMidCheckpoint) return checkpointResult;

            onCheckpointComplete(checkpointResult, checkpointIndex);
            lastResult = checkpointResult;
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
    public async searchToCheckpoint(
        registry: RegistryState,
        cat: string,
        xp: number,
        mat: string,
        config: InternalSearchConfig = {}
    ): Promise<SearchResult> {
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
        let globalTracker = new SearchStateTracker();
        const frontiers: { heap: import('#utils/collections/SearchHeap.js').SearchHeap, scale: bigint }[] = [];

        let processedMProb = 0n;
        let iterCount = 0;
        const limit = getSearchLimit(cat, threshold, maxIterations);

        if (instrumentation) {
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

            globalTracker.mass.addScaled(result.tracker.mass, mProb);
            frontiers.push({ heap: result.queue, scale: mProb });

            processedMProb += mProb;
            if (++iterCount % UI_CONSTANTS.PROGRESS_UPDATE_FREQUENCY === 0) {
                if (config.onProgress) {
                    const accuracy = globalTracker.mass.toPublic().resolved;
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
        globalTracker.mass.record('rounding', distRoundingError);


        return {
            combos: finalCombos,
            tracker: globalTracker,
            frontiers,
            instrumentation: instrumentation ? this.snapshotInstrumentation(instrumentation) : undefined,
            timing: config.timing ? { ...config.timing } : undefined,
            threshold: ProbUtils.toNumber(threshold)
        };
    }

    private updateInstrumentation(instr: EngineInstrumentation, state: SearchState): void {
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

    private snapshotInstrumentation(instr: EngineInstrumentation): EngineInstrumentation {
        return { ...instr };
    }
}
