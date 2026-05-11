import { BuiltRegistryState, EnchantStats, CheckpointSearchRequest, EngineInstrumentation, SearchResult, SequentialCheckpointSearchRequest } from '#types/index.js';
import { isItemAvailable, isMaterialEligible, getAvailablePool as getRegistryAvailablePool } from '#core/registry.js';
import { ProbUtils } from '#utils/index.js';
import { MINECRAFT_RULES } from '#constants/minecraft.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchExecutionService } from '#lib/search/SearchExecutionService.js';
import { ClueValidator } from '#core/clue.js';
import { SummaryService } from '#services/SummaryService.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { getDefaultStatsCheckpoint } from '#core/config.js';
export { EngineFactory } from './factory.js';

/**
 * Core math and logic engine for Minecraft Enchanting.
 * Orchestrates distribution calculation, best-first search, and statistics aggregation.
 * Optimized for high-speed calculation via Dependency Injection.
 */
export class EnchantEngine {
    private readonly _registry: BuiltRegistryState;
    get registry(): BuiltRegistryState { return this._registry; }

    constructor(
        registry: BuiltRegistryState,
        private readonly cache: CacheManager,
        private readonly distributionService: ModifiedLevelDistributionService,
        private readonly searchService: SearchExecutionService = new SearchExecutionService(distributionService)
    ) {
        this._registry = registry;
    }

    /** Clears all engine-level caches. */
    public resetCaches(): void {
        this.cache.clearAll();
        this.searchService.clearCache();
    }

    /** Returns current cache performance metrics. */
    public getCacheMetrics(): { distCache: { hits: number; misses: number }; poolCache: { hits: number; misses: number } } {
        return this.cache.getEngineMetrics();
    }

    public destroy(): void {
        // Shared caches are not cleared on destroy unless explicitly requested
    }

    /**
     * Retrieves the probability distribution of Modified Levels.
     */
    public getModifiedLevelDist(xp: number, enchantability: number, instrumentation?: EngineInstrumentation): { [level: number]: bigint } {
        return this.distributionService.getModifiedLevelDist(this.registry, xp, enchantability, this.cache, instrumentation);
    }

    /**
     * Returns a list of eligible enchantments filtered by conflict bitset.
     */
    public getAvailablePool(item: string, level: number, bitset: bigint = 0n): number[] {
        return getRegistryAvailablePool(this._registry, item, level, bitset, this.cache, this._registry.version);
    }

    /**
     * Runs one request through an ordered checkpoint plan and streams each completed checkpoint.
     */
    public async searchSequentialCheckpoints(request: SequentialCheckpointSearchRequest): Promise<SearchResult> {
        return this.searchService.searchSequentialCheckpoints(this.prepareSearchRequest(request));
    }

    /**
     * Advances one checkpoint search request and returns the completed boundary state.
     */
    public async searchToCheckpoint(request: CheckpointSearchRequest): Promise<SearchResult> {
        return this.searchService.searchToCheckpoint(this.prepareSearchRequest(request));
    }

    /**
     * Runs the standard checkpoint search and returns summarized stats for product/tool callers.
     * This is the simple public result API: no separate stats cache, no alternate search path.
     */
    public async getStats(request: CheckpointSearchRequest): Promise<EnchantStats> {
        const checkpoint = getDefaultStatsCheckpoint(request.item === 'book');
        const searchRequest = this.prepareSearchRequest({
            ...request,
            threshold: request.threshold ?? checkpoint.threshold,
            maxIterations: request.maxIterations ?? checkpoint.limit
        });
        const result = await this.searchService.searchToCheckpoint(searchRequest);
        const { targetClueId } = searchRequest;
        const postProcessingStart = request.timing ? performance.now() : 0;
        const summaryRequest = {
            combos: result.combos,
            snapshot: result.snapshot,
            indexToEnchant: this.registry.indexToEnchant,
            comboLimit: request.summaryLimit ?? ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
            threshold: result.threshold,
            isBook: request.item === 'book'
        };
        const stats = targetClueId === undefined
            ? SummaryService.summarize(summaryRequest)
            : SummaryService.summarizeConditioned({ ...summaryRequest, targetClueId });

        stats.instrumentation = result.instrumentation;
        if (request.timing) {
            const postProcessingMs = performance.now() - postProcessingStart;
            request.timing.postProcessingMs = (request.timing.postProcessingMs ?? 0) + postProcessingMs;
            request.timing.totalMs += postProcessingMs;
            stats.timing = { ...request.timing };
        } else {
            stats.timing = result.timing;
        }
        return stats;
    }

    private prepareSearchRequest<T extends CheckpointSearchRequest | SequentialCheckpointSearchRequest>(request: T): T & { registry: BuiltRegistryState; targetClueId?: number | undefined } {
        this.validateRequest(request);
        const targetClueId = request.clue ? this.getPackedClue(request.item, request.clue) : undefined;
        return {
            ...request,
            registry: this.registry,
            targetClueId
        };
    }

    private getPackedClue(item: string, clue: string): number {
        return ClueValidator.validate(this.registry, item, clue);
    }

    private validateRequest(request: CheckpointSearchRequest | SequentialCheckpointSearchRequest): void {
        const { item, material } = request;
        const { xp } = request;

        if (!Number.isFinite(xp) || !Number.isInteger(xp) || xp <= 0) {
            throw new Error(`Invalid XP level: ${xp}. XP must be a positive integer.`);
        }
        const xpCap = this.registry.mechanics.xp_cap ?? MINECRAFT_RULES.XP_CAP_LEGACY;
        if (xp > xpCap) {
            throw new Error(`XP level ${xp} exceeds the maximum of ${xpCap} for version ${this.registry.version}.`);
        }
        if (!isItemAvailable(this.registry, item)) {
            throw new Error(`Unknown or unavailable item: "${item}" in version ${this.registry.version}.`);
        }
        if (!isMaterialEligible(this.registry, item, material)) {
            throw new Error(`Material "${material}" is not available for item "${item}" in version ${this.registry.version}.`);
        }

        // Config validation
        if (request.threshold !== undefined) {
            const t = ProbUtils.toNumber(request.threshold);
            if (t < 0 || t > 1.0) {
                throw new Error(`Invalid threshold: ${t}. Threshold must be between 0 and 1.0.`);
            }
        }
        if (request.maxIterations !== undefined && (request.maxIterations <= 0 || !Number.isInteger(request.maxIterations))) {
            throw new Error(`Invalid maxIterations: ${request.maxIterations}. Must be a positive integer.`);
        }
        if ('checkpoints' in request) {
            for (const checkpoint of request.checkpoints) {
                if (checkpoint.targetClassifiedMass === undefined) continue;
                const target = ProbUtils.toNumber(checkpoint.targetClassifiedMass);
                if (target < 0 || target > 1.0) {
                    throw new Error(`Invalid checkpoint targetClassifiedMass: ${target}. Must be between 0 and 1.0.`);
                }
            }
        }
        if (request.resultsLimit !== undefined && (request.resultsLimit <= 0 || request.resultsLimit > 1_000_000)) {
            throw new Error(`Invalid resultsLimit: ${request.resultsLimit}. Must be between 1 and 1,000,000.`);
        }

    }
}
