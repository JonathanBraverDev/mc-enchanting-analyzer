import { CalculationStats, SearchState, RegistryState, SearchConfig, EngineInstrumentation } from '#types/index.js';
import { KeyUtils, ProbUtils } from '#utils/index.js';
import { getCategoryId, getMaterialId, isCategoryAvailable, getEligibleListNumeric as getRegistryEligibleListNumeric } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { MINECRAFT_RULES } from '#constants/minecraft.js';
import { getSearchLimit } from '#engine/utils.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { SummaryService } from '#services/SummaryService.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchService } from '#engine/search/SearchService.js';
import { ClueValidator } from '#core/clue.js';
export { EngineFactory } from './factory.js';

/**
 * Core math and logic engine for Minecraft Enchanting.
 * Orchestrates distribution calculation, best-first search, and statistics aggregation.
 * Optimized for high-speed calculation via Dependency Injection.
 */
export class EnchantEngine {
    private readonly _registry: RegistryState;
    get registry(): RegistryState { return this._registry; }

    constructor(
        registry: RegistryState,
        private readonly cache: CacheManager,
        private readonly distributionService: ModifiedLevelDistributionService,
        private readonly searchService: SearchService
    ) {
        this._registry = registry;
    }

    /** Clears all engine-level caches. */
    public resetCaches(): void {
        this.cache.clearAll();
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
    public getEligibleListNumeric(cat: string, level: number, bitset: bigint = 0n): number[] {
        return getRegistryEligibleListNumeric(this._registry, cat, level, bitset, this.cache, this._registry.version);
    }

    /**
     * Search for enchantment combinations at a specific modified level.
     *
     * @param cat Item category.
     * @param modLevel The pre-computed modified level for this search.
     * @param mat Item material.
     * @param threshold High-precision bigint threshold (1.0 = 10^18).
     * @param maxIterations Max nodes to process.
     * @param resultsLimit Max unique combinations to return.
     * @param instrumentation Optional performance tracking.
     */
    public async search(
        cat: string,
        modLevel: number,
        mat: string,
        threshold: bigint = ProbUtils.toBigInt(ENGINE_LIMITS.DEFAULT_THRESHOLD),
        maxIterations?: number,
        resultsLimit: number = ENGINE_LIMITS.MAX_RESULTS_SIZE,
        instrumentation?: EngineInstrumentation
    ): Promise<SearchState> {
        const cacheKey = this.getPackedKey(cat, modLevel, mat);
        const cached = this.cache.getSearchState(cat, this.registry.version, cacheKey) as SearchState | undefined;
        // This one-level API returns a frontier directly, so a complete cached frontier is already
        // the full answer. Request-level searches still enter SearchService to preserve reporting.
        if (cached && cached.threshold <= threshold) return cached;

        return this.searchService.searchModifiedLevel(this.registry, cat, modLevel, {
            mat,
            useCache: true,
            existingState: cached,
            threshold,
            limit: getSearchLimit(cat, ProbUtils.toNumber(threshold), maxIterations),
            resultsLimit,
            instrumentation
        });
    }

    /**
     * Sequential checkpoint version of searchToCheckpoint for v5 workers.
     * Streams search results via callback for each checkpoint.
     */
    public async searchSequentialCheckpoints(
        cat: string,
        xp: number,
        mat: string,
        checkpoints: Array<{ threshold: number; limit: number }>,
        onCheckpointComplete: (result: import('#types/index.js').SearchResult, checkpointIndex: number) => void,
        config: SearchConfig = {}
    ): Promise<import('#types/index.js').SearchResult> {
        this.validateRequest(cat, xp, mat, config);

        return this.searchService.searchSequentialCheckpoints(
            this.registry, cat, xp, mat, checkpoints, onCheckpointComplete, config
        );
    }

    /**
     * Internal method for v5 workers to get search results.
     */
    public async searchToCheckpoint(
        cat: string,
        xp: number,
        mat: string,
        config: SearchConfig = {}
    ): Promise<import('#types/index.js').SearchResult> {
        this.validateRequest(cat, xp, mat, config);

        return this.searchService.searchToCheckpoint(this.registry, cat, xp, mat, config);
    }

    /**
     * Aggregates all statistics for a given enchantment attempt.
     * Use this for standard single-pass calculations (e.g. standard UI search).
     *
     * @param cat The item category (e.g., 'sword', 'pickaxe').
     * @param xp The base XP level from the enchantment table (1-50).
     * @param mat The item material (e.g., 'diamond', 'netherite').
     * @param config Optional search configuration (threshold, signals, etc).
     * @returns A promise resolving to the final aggregated statistics.
     */
    public async calculate(
        cat: string,
        xp: number,
        mat: string,
        config: SearchConfig = {}
    ): Promise<CalculationStats> {
        this.validateRequest(cat, xp, mat, config);

        const {
            clue,
            threshold = ENGINE_LIMITS.DEFAULT_THRESHOLD,
            signal,
            onProgress,
            maxIterations,
            summaryLimit = ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_SIZE,
            useCache,
            instrumentation,
            timing
        } = config;

        const packedClue = clue ? this.getPackedClue(cat, clue) : null;

        const cacheKey = this.getStatsKey(cat, xp, mat, packedClue);

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

        const finalResult = await this.searchService.searchToCheckpoint(this.registry, cat, xp, mat, searchConfig);

        const isBook = cat === "book";
        const finalStats = packedClue
            ? SummaryService.summarizeConditioned(finalResult.combos, finalResult.tracker, this.registry.indexToEnchant, packedClue, summaryLimit, finalResult.frontiers, isBook)
            : SummaryService.summarize(
                finalResult.combos,
                finalResult.tracker,
                this.registry.indexToEnchant,
                summaryLimit,
                finalResult.threshold,
                finalResult.frontiers,
                isBook
            );

        finalStats.instrumentation = finalResult.instrumentation;
        finalStats.timing = finalResult.timing;

        const currentCached = this.cache.getStats(this.registry.version, cacheKey);
        if (!currentCached || finalStats.accuracy > currentCached.accuracy) {
            this.cache.setStats(this.registry.version, cacheKey, finalStats);
        }

        return finalStats;
    }

    private getPackedClue(cat: string, clue: string): number {
        return ClueValidator.validate(this.registry, cat, clue);
    }

    private getPackedKey(cat: string, modLevel: number, mat: string): number {
        const catId = getCategoryId(this.registry, cat);
        const matId = getMaterialId(this.registry, mat);

        return KeyUtils.getPackedKey(catId, matId, modLevel);
    }

    private getStatsKey(cat: string, xp: number, mat: string, packedClue: number | null = null): number {
        const catId = getCategoryId(this.registry, cat);
        const matId = getMaterialId(this.registry, mat);

        let key = KeyUtils.getStatsKey(catId, matId, xp);
        if (packedClue !== null) {
            // Encode the clue into the high bits above the cat/material/level fields.
            key |= (packedClue << 18);
        }
        return key;
    }

    private validateRequest(cat: string, xp: number, mat: string, config: SearchConfig): void {

        if (!Number.isFinite(xp) || !Number.isInteger(xp) || xp <= 0) {
            throw new Error(`Invalid XP level: ${xp}. XP must be a positive integer.`);
        }
        const xpCap = this.registry.mechanics.xp_cap ?? MINECRAFT_RULES.XP_CAP_LEGACY;
        if (xp > xpCap) {
            throw new Error(`XP level ${xp} exceeds the maximum of ${xpCap} for version ${this.registry.version}.`);
        }
        if (!isCategoryAvailable(this.registry, cat)) {
            throw new Error(`Unknown or unavailable category: "${cat}" in version ${this.registry.version}.`);
        }
        if (getMaterialId(this.registry, mat) === ENGINE_LIMITS.UNKNOWN_MATERIAL_ID) {
            throw new Error(`Unknown material: "${mat}".`);
        }

        // Config validation
        if (config.threshold !== undefined) {
            const t = ProbUtils.toNumber(config.threshold);
            if (t < 0 || t > 1.0) {
                throw new Error(`Invalid threshold: ${t}. Threshold must be between 0 and 1.0.`);
            }
        }
        if (config.maxIterations !== undefined && (config.maxIterations <= 0 || !Number.isInteger(config.maxIterations))) {
            throw new Error(`Invalid maxIterations: ${config.maxIterations}. Must be a positive integer.`);
        }
        if (config.resultsLimit !== undefined && (config.resultsLimit <= 0 || config.resultsLimit > 1_000_000)) {
            throw new Error(`Invalid resultsLimit: ${config.resultsLimit}. Must be between 1 and 1,000,000.`);
        }

    }
}
