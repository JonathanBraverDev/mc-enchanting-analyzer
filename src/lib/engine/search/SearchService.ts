import { SearchHeap } from '../../utils/collections/SearchHeap.js';
import { PRECISION, ProbUtils, ComboUtils, AsyncUtils } from '../../utils/index.js';
import { getEligiblePool } from '../../core/registry.js';
import { ENGINE_LIMITS, SEARCH_CONSTANTS } from '../../constants/engine.js';
import { PackedCombo, SearchFrontier, RegistryState, EngineInstrumentation, MassCheckpoint, EngineExitReason, SearchTiming, ForwardingContext } from '../../types/index.js';
import { FrontierFactory } from '../frontier.js';
import { ProbabilityMassTracker } from '../ProbabilityMassTracker.js';
import { SearchProcessor } from './SearchProcessor.js';
import { CacheManager } from '../../services/CacheManager.js';

/**
 * Shared context for a specific search execution.
 */
export interface SearchContext {
    threshold: bigint;
    limit: number;
    resultsLimit: number;
    signal?: AbortSignal;
    instrumentation?: EngineInstrumentation;
    timing?: SearchTiming;
}

/**
 * Service for the Best-First search of enchantment combinations.
 * Orchestrates the search loop and checkpointing with full DI.
 */
export class SearchService {
    constructor(private readonly cache: CacheManager) {}

    /**
     * Iteratively calculates enchantment combinations using a Best-First approach.
     */
    public async calculateCombinations(
        registry: RegistryState,
        cat: string,
        modLevel: number,
        guaranteedFirst: string | null = null,
        existingFrontier?: SearchFrontier,
        config?: SearchContext
    ): Promise<SearchFrontier> {
        const {
            threshold = 0n,
            limit = ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_SIZE,
            signal,
            instrumentation,
            timing: timingResult
        } = config ?? {};

        let startTime = 0;
        if (timingResult) startTime = performance.now();
        
        const timing = timingResult ? {
            totalMs: 0,
            searchMs: 0,
            filteringMs: 0,
            distributionMs: 0,
            settlingMs: 0,
            heapMs: 0
        } : undefined;

        const frontier = FrontierFactory.create(registry, cat, modLevel, guaranteedFirst, existingFrontier, threshold);
        const { results, queue, tracker } = frontier;
        
        const guaranteedFirstId = FrontierFactory.getGuaranteedFirstId(registry, guaranteedFirst);
        const initialPool = getEligiblePool(registry, cat, modLevel, this.cache, registry.version);
        if (instrumentation) {
            instrumentation.poolCache = this.cache.getEngineMetrics().poolCache;
        }
        const poolWeights = initialPool.map(e => registry.weightMap[e >> 8]);
        const initialTotalWeight = poolWeights.reduce((a, b) => a + b, 0);

        const ctx: ForwardingContext = {
            registry,
            results,
            queue,
            anyMass: frontier.anyMass,
            rankMass: frontier.rankMass,
            countMass: frontier.countMass,
            resultsLimit,
            instrumentation,
            timing: timing ? { ...timing } : undefined,
            cat,
            guaranteedFirstId,
            pool: initialPool,
            poolWeights,
            initialTotalWeight
        };

        if (initialPool.length === 0) {
            return this.handleEmptyPool(threshold);
        }

        let iterations = 0;
        let checkpointIdx = 0;
        const localCheckpoints: MassCheckpoint[] = [];
        let exitReason: EngineExitReason | undefined;
        const current = { meta: 0n, prob: 0n, level: 0, combo: 0 as any as PackedCombo };

        while (queue.size() > 0 && iterations < limit) {
            const nextProb = queue.peekProb();

            if (iterations > 0 && iterations % 1000 === 0) {
                if (instrumentation) {
                    instrumentation.queueSize = queue.size();
                    instrumentation.indexMapSize = queue.indexMapSize;
                    instrumentation.resultsSize = results.size;
                }
                await AsyncUtils.yield();
                if (signal?.aborted) {
                    exitReason = 'aborted';
                    break;
                }
            }

            if (nextProb < threshold) {
                exitReason = 'threshold';
                break;
            }

            if (queue.size() > ENGINE_LIMITS.MAX_QUEUE_SIZE) {
                exitReason = 'exhausted';
                break;
            }

            iterations++;
            frontier.nodesProcessed++;
            
            if (!SearchProcessor.withTiming(timing, 'heapMs', () => queue.popFast(current as any))) break;

            tracker.subtract('pending', current.prob);
            const currentCount = ComboUtils.getCount(current.combo);

            SearchProcessor.withTiming(timing, 'searchMs', () => {
                if (currentCount === 0) {
                    SearchProcessor.processInitialNode(current.prob, current.meta, modLevel, ctx, tracker);
                } else {
                    SearchProcessor.processSearchNode(current.prob, current.meta, current.combo, currentCount, ctx, tracker);
                }
            });

            // Checkpoints
            const bk = tracker.getBookkeeping();
            while (checkpointIdx < SEARCH_CONSTANTS.CHECKPOINT_TARGETS.length) {
                const targetMass = SEARCH_CONSTANTS.CHECKPOINT_TARGETS[checkpointIdx];
                const currentSettledMass = bk.resolved + bk.sieved + bk.overflow;
                if (currentSettledMass < targetMass) break;
                localCheckpoints.push({
                    modLevel,
                    threshold: ProbUtils.toNumber(current.prob),
                    mass: ProbUtils.toNumber(currentSettledMass),
                    iterations,
                    totalIterations: iterations
                });
                checkpointIdx++;
            }
        }

        if (!exitReason) {
            if (queue.size() === 0) exitReason = 'empty';
            else if (iterations >= limit) exitReason = 'iterations';
            else exitReason = 'threshold';
        }

        if (timingResult && timing) {
            timing.totalMs = performance.now() - startTime;
            timingResult.totalMs += timing.totalMs; // Update passed timing object
            // Also update the sub-buckets if we want cumulative
            timingResult.searchMs += timing.searchMs;
            timingResult.filteringMs += timing.filteringMs;
            timingResult.distributionMs += timing.distributionMs;
            timingResult.settlingMs += timing.settlingMs;
            timingResult.heapMs += timing.heapMs;
        }
        
        return { ...frontier, tracker, iterations, checkpoints: localCheckpoints, exitReason };
    }

    private handleEmptyPool(threshold: bigint): SearchFrontier {
        const rootTracker = new ProbabilityMassTracker();
        rootTracker.record('resolved', PRECISION);
        const anyMass = new BigUint64Array(256);
        const rankMass = new BigUint64Array(16384);
        const countMass = new BigUint64Array(16);
        countMass[0] = PRECISION;

        return {
            queue: new SearchHeap(),
            results: new Map(),
            anyMass,
            rankMass,
            countMass,
            tracker: rootTracker,
            threshold,
            iterations: 0,
            nodesProcessed: 0,
            checkpoints: [],
            exitReason: 'empty'
        };
    }
}
