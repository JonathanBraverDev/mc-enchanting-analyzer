import { CalculationStats, SearchState, RegistryState, SearchConfig, InternalSearchConfig, EngineInstrumentation, } from '#types/index.js';
import { ProbUtils } from '#utils/index.js';
import { getMaterialId, isCategoryAvailable, getEligibleListNumeric as getRegistryEligibleListNumeric } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { MINECRAFT_RULES } from '#constants/minecraft.js';
import { getSearchLimit } from '#engine/utils.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { KeyService } from '#engine/cache/KeyService.js';
import { SummaryService } from '#services/SummaryService.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchService } from '#engine/search/SearchService.js';
import { ProgressiveStatsAggregator } from '#engine/aggregation/ProgressiveStatsAggregator.js';
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
        private readonly keyService: KeyService,
        private readonly distributionService: ModifiedLevelDistributionService,
        private readonly searchService: SearchService,
        private readonly statAggregator: ProgressiveStatsAggregator
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
        const limit = getSearchLimit(cat, ProbUtils.toNumber(threshold), maxIterations);
        const cacheKey = this.keyService.getPackedKey(this.registry, cat, modLevel, mat);

        const cached = this.cache.getSearchState(cat, this.registry.version, cacheKey);
        if (cached && cached.threshold <= threshold) return cached as SearchState;

        const result = await this.searchService.search(
            this.registry, cat, modLevel, cached as SearchState, {
                threshold,
                limit,
                resultsLimit,
                instrumentation
            }
        );

        this.cache.setSearchState(cat, this.registry.version, cacheKey, result);
        return result;
    }

    /**
     * Aggregates statistics using a tiered progressive search.
     * Fires a callback after each tier completes, allowing for responsive UI updates
     * without waiting for the finest precision.
     *
     * @param cat The item category.
     * @param xp The base XP level.
     * @param mat The item material.
     * @param tiers Array of search depths (thresholds and iteration limits).
     * @param onTierComplete Callback fired when a tier finishing aggregating.
     * @param config Optional base configuration.
     */
    public async calculateProgressive(
        cat: string,
        xp: number,
        mat: string,
        tiers: Array<{ threshold: number; limit: number }>,
        onTierComplete: (stats: CalculationStats, tierIndex: number) => void,
        config?: Partial<SearchConfig>
    ): Promise<CalculationStats> {
        this.validateRequest(cat, xp, mat, config ?? {});

        const {
            clue,
            threshold = ENGINE_LIMITS.DEFAULT_THRESHOLD,
            signal,
            onProgress,
            maxIterations,
            summaryLimit = ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_SIZE,
            instrumentation,
            timing
        } = config ?? {};

        const packedClue = clue ? this.getPackedClue(cat, clue) : null;

        const cacheKey = this.keyService.getStatsKey(this.registry, cat, xp, mat, packedClue);

        const cachedStats = this.cache.getStats(this.registry.version, cacheKey);
        const lastTier = tiers[tiers.length - 1];
        const finestThreshold = lastTier?.threshold ?? Infinity;
        if (cachedStats && cachedStats.threshold <= finestThreshold) return cachedStats;

        const internalConfig: InternalSearchConfig = {
            threshold,
            signal,
            onProgress,
            maxIterations,
            summaryLimit,
            resultsLimit,
            instrumentation,
            timing,
            getCacheMetrics: () => ({
                cacheNodes: this.cache.getTotalCachedNodes(),
                cacheResults: this.cache.getTotalCachedResults()
            })
        };

        const wrappedOnTierComplete = (raw: any, tierIndex: number) => {
            const stats = packedClue
                ? SummaryService.summarizeConditioned(raw.combos, raw.tracker, this.registry.indexToEnchant, packedClue, summaryLimit)
                : SummaryService.summarize(raw.combos, raw.tracker, this.registry.indexToEnchant, summaryLimit, raw.threshold);

            stats.instrumentation = raw.instrumentation;
            stats.timing = raw.timing;

            onTierComplete(stats, tierIndex);
            const currentCached = this.cache.getStats(this.registry.version, cacheKey);
            if (!currentCached || stats.accuracy > currentCached.accuracy) {
                this.cache.setStats(this.registry.version, cacheKey, stats);
            }
        };

        const finalRaw = await this.statAggregator.calculateTiered(
            this.registry, cat, xp, mat, tiers, wrappedOnTierComplete, internalConfig
        );

        const finalStats = packedClue
            ? SummaryService.summarizeConditioned(finalRaw.combos, finalRaw.tracker, this.registry.indexToEnchant, packedClue, summaryLimit)
            : SummaryService.summarize(
                finalRaw.combos,
                finalRaw.tracker,
                this.registry.indexToEnchant,
                summaryLimit,
                finalRaw.threshold
            );

        finalStats.instrumentation = finalRaw.instrumentation;
        finalStats.timing = finalRaw.timing;

        const currentCached = this.cache.getStats(this.registry.version, cacheKey);
        if (!currentCached || finalStats.accuracy > currentCached.accuracy) {
            this.cache.setStats(this.registry.version, cacheKey, finalStats);
        }

        return finalStats;
    }

    /**
     * Tiered version of calculateTop for v5 workers.
     * Streams raw aggregation results via callback for each tier.
     */
    public async calculateTiered(
        cat: string,
        xp: number,
        mat: string,
        tiers: Array<{ threshold: number; limit: number }>,
        onTierComplete: (result: import('#types/index.js').AggregationResult, tierIndex: number) => void,
        config: SearchConfig = {}
    ): Promise<import('#types/index.js').AggregationResult> {
        this.validateRequest(cat, xp, mat, config);

        const internalConfig: InternalSearchConfig = {
            threshold: ProbUtils.toBigInt(tiers[tiers.length - 1]?.threshold ?? 0),
            signal: config.signal,
            onProgress: config.onProgress,
            instrumentation: config.instrumentation,
            timing: config.timing,
            ...this.makeExtendedCacheConfig(cat, mat),
        };

        return this.statAggregator.calculateTiered(
            this.registry, cat, xp, mat, tiers, onTierComplete, internalConfig
        );
    }

    /**
     * Internal method for v5 workers to get raw aggregation results.
     */
    public async calculateTop(
        cat: string,
        xp: number,
        mat: string,
        config: SearchConfig = {}
    ): Promise<import('#types/index.js').AggregationResult> {
        this.validateRequest(cat, xp, mat, config);

        const internalConfig: InternalSearchConfig = {
            threshold: config.threshold ?? ENGINE_LIMITS.DEFAULT_THRESHOLD,
            signal: config.signal,
            onProgress: config.onProgress,
            maxIterations: config.maxIterations,
            instrumentation: config.instrumentation,
            timing: config.timing,
            ...this.makeExtendedCacheConfig(cat, mat),
        };

        return this.statAggregator.calculate(this.registry, cat, xp, mat, internalConfig);
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
            instrumentation,
            timing
        } = config;

        const packedClue = clue ? this.getPackedClue(cat, clue) : null;

        const cacheKey = this.keyService.getStatsKey(this.registry, cat, xp, mat, packedClue);

        const cachedStats = this.cache.getStats(this.registry.version, cacheKey);
        if (cachedStats && cachedStats.threshold <= threshold) return cachedStats;

        const internalConfig: InternalSearchConfig = {
            threshold,
            signal,
            onProgress,
            maxIterations,
            summaryLimit,
            resultsLimit,
            instrumentation,
            timing,
            ...this.makeExtendedCacheConfig(cat, mat),
        };

        const finalRaw = await this.statAggregator.calculate(
            this.registry, cat, xp, mat, internalConfig
        );

        const isBook = cat === "book";
        const finalStats = packedClue
            ? SummaryService.summarizeConditioned(finalRaw.combos, finalRaw.tracker, this.registry.indexToEnchant, packedClue, summaryLimit, finalRaw.frontiers, isBook)
            : SummaryService.summarize(
                finalRaw.combos,
                finalRaw.tracker,
                this.registry.indexToEnchant,
                summaryLimit,
                finalRaw.threshold,
                finalRaw.frontiers,
                isBook
            );

        finalStats.instrumentation = finalRaw.instrumentation;
        finalStats.timing = finalRaw.timing;

        const currentCached = this.cache.getStats(this.registry.version, cacheKey);
        if (!currentCached || finalStats.accuracy > currentCached.accuracy) {
            this.cache.setStats(this.registry.version, cacheKey, finalStats);
        }

        return finalStats;
    }

    private getPackedClue(cat: string, clue: string): number {
        return ClueValidator.validate(this.registry, cat, clue);
    }

    /**
     * Builds the extended cache accessor pair for InternalSearchConfig.
     * Centralises the key derivation and book/combo routing that would
     * otherwise be duplicated in every public calculation method.
     */
    private makeExtendedCacheConfig(cat: string, mat: string): Pick<InternalSearchConfig, 'getExtendedCache' | 'setExtendedCache' | 'getCacheMetrics'> {
        return {
            getExtendedCache: (ml: number) => {
                const pk = this.keyService.getPackedKey(this.registry, cat, ml, mat);
                return this.cache.getSearchState(cat, this.registry.version, pk) as SearchState;
            },
            setExtendedCache: (ml: number, state: SearchState) => {
                const pk = this.keyService.getPackedKey(this.registry, cat, ml, mat);
                this.cache.setSearchState(cat, this.registry.version, pk, state);
            },
            getCacheMetrics: () => ({
                cacheNodes: this.cache.getTotalCachedNodes(),
                cacheResults: this.cache.getTotalCachedResults()
            })
        };
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
