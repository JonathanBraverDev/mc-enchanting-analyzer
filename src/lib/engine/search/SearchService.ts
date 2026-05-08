import { AsyncUtils, KeyUtils, PRECISION, ProbUtils } from '#utils/index.js';
import { getEnchantability, getEligiblePool, getItemId, getMaterialId } from '#core/registry.js';
import { ENGINE_LIMITS, UI_CONSTANTS } from '#constants/engine.js';
import { CheckpointSearchContext, EngineInstrumentation, ModifiedLevelSearchContext, PackedCombo, RegistryState, SearchContext, SearchFrontierSnapshot, SearchResult, SearchState, ForwardingContext, SequentialCheckpointSearchContext } from '#types/index.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { SearchController } from '#engine/search/SearchController.js';
import { NodeIdSearchFrontier } from '#engine/search/NodeIdSearchFrontier.js';
import { SearchPoolPlan, type SearchIdentityMode } from '#engine/search/SearchPoolPlan.js';
import { SearchNodeGraph } from '#engine/search/SearchNodeGraph.js';
import { ClueSearchPolicy } from '#engine/search/ClueSearchPolicy.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { getSearchLimit } from '#engine/utils.js';

export interface SearchServiceOptions {
    readonly identityModeOverride?: SearchIdentityMode | undefined;
}

interface CheckpointAccumulator {
    combos: Map<PackedCombo, bigint>;
    tracker: SearchStateTracker;
    frontiers: SearchFrontierSnapshot[];
    processedMProb: bigint;
}

/**
 * Service for the Best-First search of enchantment combinations.
 * Orchestrates the search loop with full DI.
 */
export class SearchService {
    constructor(
        private readonly cache: CacheManager,
        private readonly distributionService: ModifiedLevelDistributionService = new ModifiedLevelDistributionService(),
        private readonly options: SearchServiceOptions = {}
    ) {}

    public async searchModifiedLevel(request: ModifiedLevelSearchContext): Promise<SearchState> {
        const {
            registry,
            item,
            modLevel,
            threshold = 0n,
            limit = ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
            timing: timingResult,
            material,
            existingState,
            useCache = false,
            targetClueId
        } = request;

        const cacheKey = material !== undefined ? this.getPackedKey(registry, item, modLevel, material) : undefined;
        const canUseFrontierCache = useCache && targetClueId === undefined;
        const cached = canUseFrontierCache && cacheKey !== undefined
            ? this.cache.getSearchState(item, registry.version, cacheKey) as SearchState | undefined
            : undefined;
        let startTime = 0;
        if (timingResult) startTime = performance.now();

        const state = SearchStateTracker.createState(modLevel, existingState ?? cached, threshold);
        const { results, queue, graph } = state;

        // Minecraft fixes the eligible enchant/rank pool from the initial full modified level once.
        // Later level halving affects only the chance to continue to another enchant slot, not which
        // enchantments can appear in this run, so downstream search nodes must keep reusing this pool.
        const initialPool = getEligiblePool(registry, item, modLevel, this.cache, registry.version);

        if (initialPool.length === 0) {
            return targetClueId === undefined
                ? this.handleEmptyPool(threshold)
                : this.handleClueIncompatiblePool(threshold);
        }

        const cluePolicy = targetClueId !== undefined
            ? ClueSearchPolicy.create(registry, initialPool, targetClueId)
            : undefined;

        if (cluePolicy && !cluePolicy.isReachableInPool) {
            return this.handleClueIncompatiblePool(threshold);
        }

        const poolPlan = new SearchPoolPlan(registry, initialPool, modLevel, {
            identityModeOverride: this.options.identityModeOverride
        });
        const ctx: ForwardingContext = {
            registry,
            results,
            queue,
            graph,
            resultsLimit,
            instrumentation: request.instrumentation,
            timing: timingResult ? { totalMs: 0, searchMs: 0, postProcessingMs: 0 } : undefined,
            item,
            poolPlan,
            cluePolicy
        };

        await SearchController.run(state, ctx, modLevel, {
            ...request,
            threshold,
            limit,
            resultsLimit
        } as SearchContext);

        if (timingResult) {
            const totalMs = performance.now() - startTime;
            timingResult.totalMs = (timingResult.totalMs ?? 0) + totalMs;
        }

        if (canUseFrontierCache && cacheKey !== undefined) {
            this.cache.setSearchState(item, registry.version, cacheKey, state);
        }

        return state;
    }

    /**
     * Searches all modified levels for one request target and returns the aggregated result.
     */
    public async searchToCheckpoint(request: CheckpointSearchContext): Promise<SearchResult> {
        const {
            registry,
            item,
            xp,
            material,
            threshold = ENGINE_LIMITS.DEFAULT_THRESHOLD,
            signal,
            maxIterations,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
            useCache = true,
            instrumentation
        } = request;

        const bThreshold = ProbUtils.toBigInt(threshold);
        const { modDist, levels } = this.getLevelDistribution(registry, item, xp, material, instrumentation);
        const accumulator = this.createCheckpointAccumulator();
        let iterCount = 0;
        const limit = getSearchLimit(item, threshold, maxIterations);

        this.prepareInstrumentation(instrumentation);

        for (const ml of levels) {
            if (signal?.aborted) throw new Error("Aborted");

            const mProb = modDist[ml];
            if (mProb === undefined) continue;
            if (instrumentation) {
                instrumentation.frontierCache = this.cache.getEngineMetrics().frontierCache;
            }

            const result = await this.searchModifiedLevel({
                registry,
                item,
                modLevel: ml,
                material,
                useCache,
                threshold: bThreshold,
                limit,
                resultsLimit,
                signal,
                instrumentation,
                timing: request.timing,
                targetClueId: request.targetClueId
            });

            if (instrumentation) {
                this.updateInstrumentation(instrumentation, result);
                if (instrumentation.trackGlobalMetrics) {
                    instrumentation.globalResultsSize = accumulator.combos.size;
                    instrumentation.globalCacheNodes = this.cache.getTotalCachedNodes();
                    instrumentation.globalCacheResults = this.cache.getTotalCachedResults();
                }
            }

            this.recordCheckpointLevel(accumulator, result, mProb);

            if (++iterCount % UI_CONSTANTS.PROGRESS_UPDATE_FREQUENCY === 0) {
                if (request.onProgress) {
                    const accounting = accumulator.tracker.mass.toPublic();
                    const accuracy = accounting.resolved + accounting.clueIncompatible;
                    request.onProgress({
                        processed: iterCount,
                        total: levels.length,
                        accuracy
                    });
                }
                await AsyncUtils.yield();
            }
        }

        return this.finalizeCheckpoint(accumulator, ProbUtils.toNumber(threshold), instrumentation, request.timing);
    }

    /**
     * Searches a sequence of request checkpoints and streams each aggregated checkpoint result.
     */
    public async searchSequentialCheckpoints(request: SequentialCheckpointSearchContext): Promise<SearchResult> {
        const { registry, item, xp, material, checkpoints, onCheckpointComplete, signal, instrumentation } = request;

        const { modDist, levels } = this.getLevelDistribution(registry, item, xp, material, instrumentation);

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
            const accumulator = this.createCheckpointAccumulator();

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
                    item,
                    modLevel: ml,
                    existingState,
                    threshold: activeThreshold,
                    limit: checkpoint.limit,
                    resultsLimit: request.resultsLimit ?? ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
                    signal,
                    instrumentation,
                    timing: request.timing,
                    targetClueId: request.targetClueId
                });

                stateMap.set(ml, result);

                if (instrumentation) {
                    this.updateInstrumentation(instrumentation, result);
                }

                this.recordCheckpointLevel(accumulator, result, mProb);

                processedMProb += mProb;
                await AsyncUtils.yield();
            }

            const checkpointResult = this.finalizeCheckpoint(accumulator, checkpoint.threshold, instrumentation, request.timing);

            if (abortedMidCheckpoint) {
                return processedMProb === 0n ? lastResult : checkpointResult;
            }

            onCheckpointComplete(checkpointResult, checkpointIndex);
            lastResult = checkpointResult;
        }

        return lastResult;
    }

    private getLevelDistribution(registry: RegistryState, item: string, xp: number, material: string, instrumentation?: EngineInstrumentation): { modDist: { [level: number]: bigint }; levels: number[] } {
        const enchantability = getEnchantability(registry, material, item);
        const modDist = this.distributionService.getModifiedLevelDist(registry, xp, enchantability, this.cache, instrumentation);
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);

        return { modDist, levels };
    }

    private createCheckpointAccumulator(): CheckpointAccumulator {
        return {
            combos: new Map<PackedCombo, bigint>(),
            tracker: new SearchStateTracker(),
            frontiers: [],
            processedMProb: 0n
        };
    }

    private recordCheckpointLevel(accumulator: CheckpointAccumulator, result: SearchState, mProb: bigint): void {
        ProbUtils.addMapMass(accumulator.combos, result.results, mProb);
        accumulator.tracker.mass.addScaled(result.tracker.mass, mProb);
        accumulator.frontiers.push({ frontier: result.queue, graph: result.graph, scale: mProb });
        accumulator.processedMProb += mProb;
    }

    private finalizeCheckpoint(
        accumulator: CheckpointAccumulator,
        threshold: number,
        instrumentation?: EngineInstrumentation,
        timing?: { totalMs: number; searchMs: number; postProcessingMs?: number | undefined }
    ): SearchResult {
        const distRoundingError = PRECISION - accumulator.processedMProb;
        accumulator.tracker.mass.record('rounding', distRoundingError);

        return {
            combos: accumulator.combos,
            tracker: accumulator.tracker,
            frontiers: accumulator.frontiers,
            instrumentation: instrumentation ? this.snapshotInstrumentation(instrumentation) : undefined,
            timing: timing ? { ...timing } : undefined,
            threshold
        };
    }

    private prepareInstrumentation(instrumentation?: EngineInstrumentation): void {
        if (!instrumentation) return;

        instrumentation.totalIterations = 0;
        instrumentation.levelsFullyResolved = 0;
        instrumentation.frontierCache = instrumentation.frontierCache || { hits: 0, misses: 0 };
    }

    private handleEmptyPool(threshold: bigint): SearchState {
        const rootTracker = new SearchStateTracker();
        rootTracker.mass.record('resolved', PRECISION);

        return {
            queue: new NodeIdSearchFrontier(),
            graph: new SearchNodeGraph(),
            results: new Map(),
            tracker: rootTracker,
            threshold,
            iterations: 0,
            nodesProcessed: 0,
            exitReason: 'empty'
        };
    }

    private handleClueIncompatiblePool(threshold: bigint): SearchState {
        const rootTracker = new SearchStateTracker();
        rootTracker.mass.record('clueIncompatible', PRECISION);

        return {
            queue: new NodeIdSearchFrontier(),
            graph: new SearchNodeGraph(),
            results: new Map(),
            tracker: rootTracker,
            threshold,
            iterations: 0,
            nodesProcessed: 0,
            exitReason: 'empty'
        };
    }

    private getPackedKey(registry: RegistryState, item: string, modLevel: number, material: string): number {
        const itemId = getItemId(registry, item);
        const materialId = getMaterialId(registry, material);

        return KeyUtils.getPackedKey(itemId, materialId, modLevel);
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
