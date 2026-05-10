import { BuiltRegistryState, CalculationRequest, CalculationStats, CheckpointSearchRequest, EngineInstrumentation, ModifiedLevelSearchRequest, SearchResult, SearchConfig, SearchState, SequentialCheckpointSearchRequest } from '#types/index.js';
import { KeyUtils, ProbUtils } from '#utils/index.js';
import { getItemId, getMaterialId, isItemAvailable, isMaterialEligible, getEligibleListNumeric as getRegistryEligibleListNumeric } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { MINECRAFT_RULES } from '#constants/minecraft.js';
import { getSearchLimit } from '#engine/utils.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { SummaryService } from '#services/SummaryService.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchService } from '#engine/search/SearchService.js';
import { V7SearchService } from '#lib/v7/search/V7SearchService.js';
import { ClueValidator } from '#core/clue.js';
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
        private readonly searchService: SearchService,
        private readonly v7SearchService: V7SearchService = new V7SearchService(distributionService)
    ) {
        this._registry = registry;
    }

    /** Clears all engine-level caches. */
    public resetCaches(): void {
        this.cache.clearAll();
        this.v7SearchService.clearCache();
    }

    /** Clears only the stats cache. */
    public resetStatsCache(): void {
        this.cache.clearStats();
    }

    /** Returns current cache performance metrics. */
    public getCacheMetrics(): { distCache: { hits: number; misses: number }; poolCache: { hits: number; misses: number }; frontierCache: { hits: number; misses: number } } {
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
    public getEligibleListNumeric(item: string, level: number, bitset: bigint = 0n): number[] {
        return getRegistryEligibleListNumeric(this._registry, item, level, bitset, this.cache, this._registry.version);
    }

    /**
     * Search for enchantment combinations at a specific modified level.
     *
     * @param item Item type.
     * @param modLevel The pre-computed modified level for this search.
     * @param material Item material.
     * @param threshold High-precision bigint threshold (1.0 = 10^18).
     * @param maxIterations Max nodes to process.
     * @param resultsLimit Max unique combinations to retain before recording capped mass.
     * @param instrumentation Optional performance tracking.
     */
    public async searchModifiedLevel(request: ModifiedLevelSearchRequest): Promise<SearchState> {
        const { item, material } = request;
        const {
            modLevel,
            threshold = ProbUtils.toBigInt(ENGINE_LIMITS.DEFAULT_THRESHOLD),
            maxIterations,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
            instrumentation
        } = request;
        const cacheKey = this.getPackedKey(item, modLevel, material);
        const cached = this.cache.getSearchState(item, this.registry.version, cacheKey) as SearchState | undefined;
        // This one-level API returns a frontier directly, so a complete cached frontier is already
        // the full answer. Request-level searches still enter SearchService to preserve reporting.
        if (cached && cached.threshold <= threshold) return cached;

        return this.searchService.searchModifiedLevel({
            registry: this.registry,
            item,
            modLevel,
            material,
            useCache: true,
            existingState: cached,
            threshold,
            limit: getSearchLimit(item, ProbUtils.toNumber(threshold), maxIterations),
            resultsLimit,
            instrumentation
        });
    }

    /**
     * Sequential checkpoint version of searchToCheckpoint for v5 workers.
     * Streams search results via callback for each checkpoint.
     */
    public async searchSequentialCheckpoints(request: SequentialCheckpointSearchRequest): Promise<SearchResult> {
        this.validateRequest(request);
        const { item, material } = request;
        const targetClueId = request.clue ? this.getPackedClue(item, request.clue) : undefined;

        const service = request.engine === 'v7' ? this.v7SearchService : this.searchService;
        return service.searchSequentialCheckpoints({
            ...request,
            item,
            material,
            registry: this.registry,
            targetClueId
        });
    }

    /**
     * Internal method for v5 workers to get search results.
     */
    public async searchToCheckpoint(request: CheckpointSearchRequest): Promise<SearchResult> {
        this.validateRequest(request);
        const { item, material } = request;
        const targetClueId = request.clue ? this.getPackedClue(item, request.clue) : undefined;

        const service = request.engine === 'v7' ? this.v7SearchService : this.searchService;
        return service.searchToCheckpoint({
            ...request,
            item,
            material,
            registry: this.registry,
            targetClueId
        });
    }

    /**
     * Aggregates all statistics for a given enchantment attempt.
     * Use this for standard single-pass calculations (e.g. standard UI search).
     *
     * @param item The item type (e.g., 'sword', 'pickaxe').
     * @param xp The base XP level from the enchantment table (1-50).
     * @param material The item material (e.g., 'diamond', 'netherite').
     * @param config Optional search configuration (threshold, signals, etc).
     * @returns A promise resolving to the final aggregated statistics.
     */
    public async calculate(request: CalculationRequest): Promise<CalculationStats> {
        this.validateRequest(request);
        const { item, material } = request;

        const {
            xp,
            clue,
            threshold = ENGINE_LIMITS.DEFAULT_THRESHOLD,
            signal,
            onProgress,
            maxIterations,
            summaryLimit = ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
            useCache,
            instrumentation,
            timing
        } = request;

        const packedClue = clue ? this.getPackedClue(item, clue) : null;

        const cacheKey = this.getStatsKey(item, xp, material, packedClue, request.engine ?? 'v6');

        const cachedStats = this.cache.getStats(this.registry.version, cacheKey);
        if (cachedStats && cachedStats.threshold <= threshold) return cachedStats;

        const searchConfig: SearchConfig = {
            threshold,
            signal,
            onProgress,
            maxIterations,
            resultsLimit,
            useCache,
            instrumentation,
            timing
        };

        const service = request.engine === 'v7' ? this.v7SearchService : this.searchService;
        const finalResult = await service.searchToCheckpoint({
            registry: this.registry,
            item,
            xp,
            material,
            targetClueId: packedClue ?? undefined,
            ...searchConfig
        });

        const isBook = item === "book";
        const postProcessingStart = timing ? performance.now() : 0;
        const finalStats = packedClue
            ? SummaryService.summarizeConditioned({
                combos: finalResult.combos,
                tracker: finalResult.tracker,
                indexToEnchant: this.registry.indexToEnchant,
                targetClueId: packedClue,
                comboLimit: summaryLimit,
                frontiers: finalResult.frontiers,
                isBook,
                v7Snapshot: finalResult.v7Snapshot
            })
            : SummaryService.summarize({
                combos: finalResult.combos,
                tracker: finalResult.tracker,
                indexToEnchant: this.registry.indexToEnchant,
                comboLimit: summaryLimit,
                threshold: finalResult.threshold,
                frontiers: finalResult.frontiers,
                isBook,
                v7Snapshot: finalResult.v7Snapshot
            });

        finalStats.instrumentation = finalResult.instrumentation;
        if (timing) {
            const postProcessingMs = performance.now() - postProcessingStart;
            timing.postProcessingMs = (timing.postProcessingMs ?? 0) + postProcessingMs;
            timing.totalMs += postProcessingMs;
            finalStats.timing = { ...timing };
        } else {
            finalStats.timing = finalResult.timing;
        }

        const currentCached = this.cache.getStats(this.registry.version, cacheKey);
        if (!currentCached || finalStats.accuracy > currentCached.accuracy) {
            this.cache.setStats(this.registry.version, cacheKey, finalStats);
        }

        return finalStats;
    }

    private getPackedClue(item: string, clue: string): number {
        return ClueValidator.validate(this.registry, item, clue);
    }

    private getPackedKey(item: string, modLevel: number, material: string): number {
        const itemId = getItemId(this.registry, item);
        const materialId = getMaterialId(this.registry, material);

        return KeyUtils.getPackedKey(itemId, materialId, modLevel);
    }

    private getStatsKey(item: string, xp: number, material: string, packedClue: number | null = null, engine: 'v6' | 'v7' = 'v6'): number {
        const itemId = getItemId(this.registry, item);
        const materialId = getMaterialId(this.registry, material);

        let key = KeyUtils.getStatsKey(itemId, materialId, xp);
        if (packedClue !== null) {
            // Encode the clue into the high bits above the item/material/level fields.
            key += packedClue * (2 ** 18);
        }
        if (engine === 'v7') {
            // V7 has intentionally different cutoff semantics, so it must not share
            // cached CalculationStats with V6 even while both project to the same shape.
            key += 2 ** 30;
        }
        return key;
    }

    private validateRequest(request: CalculationRequest | CheckpointSearchRequest | SequentialCheckpointSearchRequest): void {
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
        if (request.resultsLimit !== undefined && (request.resultsLimit <= 0 || request.resultsLimit > 1_000_000)) {
            throw new Error(`Invalid resultsLimit: ${request.resultsLimit}. Must be between 1 and 1,000,000.`);
        }

    }
}
