import { PRECISION, ProbUtils } from '#utils/index.js';
import { getEligiblePool } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { SearchState, RegistryState, SearchContext, ForwardingContext } from '#types/index.js';
import { StateFactory } from './StateFactory.js';
import { SearchManager } from './SearchManager.js';
import { SearchController } from './SearchController.js';
import { SearchHeap } from '#utils/collections/SearchHeap.js';
import { CacheManager } from '#engine/cache/CacheManager.js';

/**
 * Service for the Best-First search of enchantment combinations.
 * Orchestrates the search loop and checkpointing with full DI.
 */
export class SearchService {
    constructor(private readonly cache: CacheManager) {}

    /**
     * Search for enchantment combinations.
     */
    public async search(
        registry: RegistryState,
        cat: string,
        modLevel: number,
        guaranteedFirst: string | null = null,
        existingState?: SearchState,
        config?: SearchContext
    ): Promise<SearchState> {
        const {
            threshold = 0n,
            limit = ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_SIZE,
            timing: timingResult
        } = config ?? {};

        let startTime = 0;
        if (timingResult) startTime = performance.now();
        
        const state = StateFactory.create(registry, cat, modLevel, guaranteedFirst, existingState, threshold);
        const { results, queue, tracker } = state;
        
        const guaranteedFirstId = StateFactory.getGuaranteedFirstId(registry, guaranteedFirst);
        const initialPool = getEligiblePool(registry, cat, modLevel, this.cache, registry.version);
        
        const poolWeights = initialPool.map(e => registry.weightMap[e >> 8]);
        const initialTotalWeight = poolWeights.reduce((a, b) => a + b, 0);

        if (initialPool.length === 0) {
            return this.handleEmptyPool(threshold);
        }

        const ctx: ForwardingContext = {
            registry,
            results,
            queue,
            anyMass: state.anyMass,
            rankMass: state.rankMass,
            countMass: state.countMass,
            resultsLimit,
            instrumentation: config?.instrumentation,
            timing: timingResult ? { totalMs: 0, searchMs: 0, filteringMs: 0, distributionMs: 0, settlingMs: 0, heapMs: 0 } : undefined,
            cat,
            guaranteedFirstId,
            pool: initialPool,
            poolWeights,
            initialTotalWeight
        };

        await SearchController.run(state, ctx, modLevel, {
            ...config,
            threshold,
            limit,
            resultsLimit
        } as SearchContext);

        if (timingResult && ctx.timing) {
            const totalMs = performance.now() - startTime;
            timingResult.totalMs += totalMs;
            timingResult.searchMs += ctx.timing.searchMs;
            timingResult.filteringMs += ctx.timing.filteringMs;
            timingResult.distributionMs += ctx.timing.distributionMs;
            timingResult.settlingMs += ctx.timing.settlingMs;
            timingResult.heapMs += ctx.timing.heapMs;
        }
        
        return state;
    }

    private handleEmptyPool(threshold: bigint): SearchState {
        const rootTracker = new SearchManager();
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
