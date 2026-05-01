import { AsyncUtils, KeyUtils, PRECISION, ProbUtils } from '#utils/index.js';
import { getCategoryId, getEnchantability, getEligiblePool, getMaterialId } from '#core/registry.js';
import { ENGINE_LIMITS, PACKING_CONSTANTS, UI_CONSTANTS } from '#constants/engine.js';
import { CheckpointSearchContext, EngineInstrumentation, ModifiedLevelSearchContext, PackedCombo, RegistryState, SearchContext, SearchResult, SearchState, ForwardingContext, SequentialCheckpointSearchContext } from '#types/index.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { SearchController } from '#engine/search/SearchController.js';
import { SearchHeap } from '#utils/collections/SearchHeap.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { getSearchLimit } from '#engine/utils.js';

/**
 * Service for the Best-First search of enchantment combinations.
 * Orchestrates the search loop with full DI.
 */
export class SearchService {
    constructor(
        private readonly cache: CacheManager,
        private readonly distributionService: ModifiedLevelDistributionService = new ModifiedLevelDistributionService()
    ) {}

    public async searchModifiedLevel(request: ModifiedLevelSearchContext): Promise<SearchState> {
        const {
            registry,
            cat,
            modLevel,
            threshold = 0n,
            limit = ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_SIZE,
            timing: timingResult,
            mat,
            existingState,
            useCache = false
        } = request;

        const cacheKey = mat !== undefined ? this.getPackedKey(registry, cat, modLevel, mat) : undefined;
        const cached = useCache && cacheKey !== undefined
            ? this.cache.getSearchState(cat, registry.version, cacheKey) as SearchState | undefined
            : undefined;
        let startTime = 0;
        if (timingResult) startTime = performance.now();

        const state = SearchStateTracker.createState(modLevel, existingState ?? cached, threshold);
        const { results, queue } = state;

        // Minecraft fixes the eligible enchant/rank pool from the initial full modified level once.
        // Later level halving affects only the chance to continue to another enchant slot, not which
        // enchantments can appear in this run, so downstream search nodes must keep reusing this pool.
        const initialPool = getEligiblePool(registry, cat, modLevel, this.cache, registry.version);

        const poolWeights: number[] = initialPool.map(e => registry.weightMap[e >> PACKING_CONSTANTS.ENCHANT_SHIFT] ?? 0);
        const initialTotalWeight = poolWeights.reduce((a, b) => a + b, 0);

        if (initialPool.length === 0) {
            return this.handleEmptyPool(threshold);
        }

        const ctx: ForwardingContext = {
            registry,
            results,
            queue,
            resultsLimit,
            instrumentation: request.instrumentation,
            timing: timingResult ? { totalMs: 0, searchMs: 0 } : undefined,
            cat,
            pool: initialPool,
            poolWeights,
            initialTotalWeight
        };

        await SearchController.run(state, ctx, modLevel, {
            ...request,
            threshold,
            limit,
            resultsLimit
        } as SearchContext);

        if (timingResult) {
            const totalMs = performance.now() - startTime;
            timingResult.totalMs += totalMs;
        }

        if (useCache && cacheKey !== undefined) {
            this.cache.setSearchState(cat, registry.version, cacheKey, state);
        }

        return state;
    }

    /**
     * Searches all modified levels for one request target and returns the aggregated result.
     */
    public async searchToCheckpoint(request: CheckpointSearchContext): Promise<SearchResult> {
        const {
            registry,
            cat,
            xp,
            mat,
            threshold = ENGINE_LIMITS.DEFAULT_THRESHOLD,
            signal,
            maxIterations,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_SIZE,
            useCache = true,
            instrumentation
        } = request;

        const bThreshold = ProbUtils.toBigInt(threshold);
        const enchantability = getEnchantability(registry, mat, cat);
        const modDist = this.distributionService.getModifiedLevelDist(registry, xp, enchantability, this.cache, instrumentation);
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);

        const finalCombos = new Map<PackedCombo, bigint>();
        const globalTracker = new SearchStateTracker();
        const frontiers: { heap: SearchHeap, scale: bigint }[] = [];

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
            if (instrumentation) {
                instrumentation.frontierCache = this.cache.getEngineMetrics().frontierCache;
            }

            const result = await this.searchModifiedLevel({
                    registry,
                    cat,
                    modLevel: ml,
                    mat,
                    useCache,
                    threshold: bThreshold,
                    limit,
                    resultsLimit,
                    signal,
                    instrumentation,
                    timing: request.timing
                });

            if (instrumentation) {
                this.updateInstrumentation(instrumentation, result);
                if (instrumentation.trackGlobalMetrics) {
                    instrumentation.globalResultsSize = finalCombos.size;
                    instrumentation.globalCacheNodes = this.cache.getTotalCachedNodes();
                    instrumentation.globalCacheResults = this.cache.getTotalCachedResults();
                }
            }

            ProbUtils.addMapMass(finalCombos, result.results, mProb);
            globalTracker.mass.addScaled(result.tracker.mass, mProb);
            frontiers.push({ heap: result.queue, scale: mProb });

            processedMProb += mProb;
            if (++iterCount % UI_CONSTANTS.PROGRESS_UPDATE_FREQUENCY === 0) {
                if (request.onProgress) {
                    const accuracy = globalTracker.mass.toPublic().resolved;
                    request.onProgress({
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
            timing: request.timing ? { ...request.timing } : undefined,
            threshold: ProbUtils.toNumber(threshold)
        };
    }

    /**
     * Searches a sequence of request checkpoints and streams each aggregated checkpoint result.
     */
    public async searchSequentialCheckpoints(request: SequentialCheckpointSearchContext): Promise<SearchResult> {
        const { registry, cat, xp, mat, checkpoints, onCheckpointComplete, signal, instrumentation } = request;

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
            const checkpointTracker = new SearchStateTracker();

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

                const result = await this.searchModifiedLevel({
                        registry,
                        cat,
                        modLevel: ml,
                        existingState,
                        threshold: activeThreshold,
                        limit: checkpoint.limit,
                        resultsLimit: request.resultsLimit ?? ENGINE_LIMITS.MAX_RESULTS_SIZE,
                        signal,
                        instrumentation,
                        timing: request.timing
                    });

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
                timing: request.timing ? { ...request.timing } : undefined,
                threshold: checkpoint.threshold
            };

            if (abortedMidCheckpoint) {
                return processedMProb === 0n ? lastResult : checkpointResult;
            }

            onCheckpointComplete(checkpointResult, checkpointIndex);
            lastResult = checkpointResult;
        }

        return lastResult;
    }

    private handleEmptyPool(threshold: bigint): SearchState {
        const rootTracker = new SearchStateTracker();
        rootTracker.mass.record('resolved', PRECISION);

        return {
            queue: new SearchHeap(),
            results: new Map(),
            tracker: rootTracker,
            threshold,
            iterations: 0,
            nodesProcessed: 0,
            exitReason: 'empty'
        };
    }

    private getPackedKey(registry: RegistryState, cat: string, modLevel: number, mat: string): number {
        const catId = getCategoryId(registry, cat);
        const matId = getMaterialId(registry, mat);

        return KeyUtils.getPackedKey(catId, matId, modLevel);
    }

    private updateInstrumentation(instr: EngineInstrumentation, state: SearchState): void {
        instr.totalIterations = (instr.totalIterations || 0) + state.iterations;
        instr.exitReason = state.exitReason;
        instr.levelsProcessed = (instr.levelsProcessed || 0) + 1;
        if (state.exitReason === 'empty') instr.levelsFullyResolved = (instr.levelsFullyResolved || 0) + 1;
        instr.fullyResolved = instr.levelsFullyResolved === instr.levelsProcessed;

        const metrics = this.cache.getEngineMetrics();
        instr.poolCache = metrics.poolCache;
        instr.distCache = metrics.distCache;
        instr.frontierCache = metrics.frontierCache;
    }

    private snapshotInstrumentation(instr: EngineInstrumentation): EngineInstrumentation {
        return { ...instr };
    }
}
