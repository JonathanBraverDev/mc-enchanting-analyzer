import { CalculationStats, SearchState, RegistryState, SearchConfig, InternalSearchConfig, EngineInstrumentation, } from '#types/index.js';
import { ProbUtils, EnchantUtils } from '#utils/index.js';
import { getMaterialId, getEnchantId, isCategoryAvailable } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { getSearchLimit } from '#core/config.js';
import { CacheManager } from './cache/CacheManager.js';
import { KeyService } from '#services/KeyService.js';
import { PoolService } from '#services/PoolService.js';
import { SummaryService } from '#services/SummaryService.js';
import { DistributionService } from './distribution/DistributionService.js';
import { SearchService } from './search/SearchService.js';
import { StatAggregator } from './aggregation/StatAggregator.js';
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
        private readonly poolService: PoolService,
        private readonly distributionService: DistributionService,
        private readonly searchService: SearchService,
        private readonly statAggregator: StatAggregator
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
        return this.poolService.getEligibleListNumeric(this.registry, cat, level, bitset);
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
        
        const cached = cat === "book" ? this.cache.getBook(this.registry.version, cacheKey) : this.cache.getCombo(this.registry.version, cacheKey);
        // Cast cached to SearchState if needed, but the cache should already store SearchState 3.0 types
        if (cached && cached.threshold <= threshold) return cached as SearchState;

        const result = await this.searchService.search(
            this.registry, cat, modLevel, cached as SearchState, {
                threshold,
                limit,
                resultsLimit,
                instrumentation
            }
        );

        if (cat === "book") this.cache.setBook(this.registry.version, cacheKey, result);
        else this.cache.setCombo(this.registry.version, cacheKey, result);
        
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
                : SummaryService.summarize(raw.combos, raw.tracker, this.registry.indexToEnchant, raw.anyMass, raw.rankMass, raw.countMass, summaryLimit, raw.threshold);
            
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
                finalRaw.anyMass,
                finalRaw.rankMass,
                finalRaw.countMass,
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
            getExtendedCache: (ml) => {
                const pk = this.keyService.getPackedKey(this.registry, cat, ml, mat);
                return (cat === "book" ? this.cache.getBook(this.registry.version, pk) : this.cache.getCombo(this.registry.version, pk)) as SearchState;
            },
            setExtendedCache: (ml, state) => {
                const pk = this.keyService.getPackedKey(this.registry, cat, ml, mat);
                if (cat === "book") this.cache.setBook(this.registry.version, pk, state);
                else this.cache.setCombo(this.registry.version, pk, state);
            },
            instrumentation,
            timing,
            getCacheMetrics: () => ({ 
                cacheNodes: this.cache.getTotalCachedNodes(), 
                cacheResults: this.cache.getTotalCachedResults() 
            })
        };

        const finalRaw = await this.statAggregator.calculate(
            this.registry, cat, xp, mat, internalConfig
        );

        const finalStats = packedClue
            ? SummaryService.summarizeConditioned(finalRaw.combos, finalRaw.tracker, this.registry.indexToEnchant, packedClue, summaryLimit)
            : SummaryService.summarize(
                finalRaw.combos,
                finalRaw.tracker,
                this.registry.indexToEnchant,
                finalRaw.anyMass,
                finalRaw.rankMass,
                finalRaw.countMass,
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
    }    /**
     * Aggregates statistics conditioned on a specific observed clue.
     * This is the modern replacement for the legacy guaranteedFirst parameter.
     * 
     * @param cat Item category.
     * @param xp Base XP level.
     * @param mat Item material.
     * @param clue The observed enchantment clue (e.g. "Sharpness IV").
     * @param config Optional search configuration.
     */
    public async calculateConditioned(
        cat: string,
        xp: number,
        mat: string,
        clue: string,
        config: SearchConfig = {}
    ): Promise<CalculationStats> {
        this.validateRequest(cat, xp, mat, config);
        
        const romanMap = this.registry.data.constants.ROMAN_MAP;
        const parsed = EnchantUtils.parse(clue, romanMap);
        if (!parsed) throw new Error(`Invalid clue format: "${clue}"`);
        
        const clueId = getEnchantId(this.registry, parsed.name);
        const packedClue = (clueId << 8) | (parsed.rank ?? 1);

        // Perform raw calculation first (or retrieve from internal cache if possible)
        const internalConfig: InternalSearchConfig = {
            ...config,
            threshold: ProbUtils.toBigInt(config.threshold ?? ENGINE_LIMITS.DEFAULT_THRESHOLD),
            summaryLimit: config.summaryLimit ?? ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
            resultsLimit: config.resultsLimit ?? ENGINE_LIMITS.MAX_RESULTS_SIZE
        };

        const finalRaw = await this.statAggregator.calculate(
            this.registry, cat, xp, mat, internalConfig
        );

        // Apply Bayesian conditioning
        return SummaryService.summarizeConditioned(
            finalRaw.combos,
            finalRaw.tracker,
            this.registry.indexToEnchant,
            packedClue,
            internalConfig.summaryLimit
        );
    }

    private getPackedClue(cat: string, clue: string): number {
        const romanMap = this.registry.data.constants.ROMAN_MAP;
        const parsed = EnchantUtils.parse(clue, romanMap);
        if (!parsed) throw new Error(`Invalid clue format: "${clue}"`);
        
        const clueId = getEnchantId(this.registry, parsed.name);
        if (clueId === ENGINE_LIMITS.UNKNOWN_ENCHANT_ID) {
            throw new Error(`Invalid clue format: Unknown enchantment "${parsed.name}"`);
        }

        const enchantData = this.registry.resolvedRegistry[parsed.name];
        if (!enchantData) {
            throw new Error(`Invalid clue format: Unknown enchantment "${parsed.name}"`);
        }

        // Check if applicable to category
        const pool = this.registry.mergedItems[cat] || [];
        if (!pool.includes(parsed.name)) {
            throw new Error(`Invalid clue format: Enchantment "${parsed.name}" is not applicable to category "${cat}"`);
        }

        const maxRank = Object.keys(enchantData.levels).length;
        if (parsed.rank > maxRank) {
            throw new Error(`Invalid clue format: Rank ${parsed.rank} exceeds max for ${parsed.name}`);
        }

        return (clueId << 8) | (parsed.rank ?? 1);
    }


    private validateRequest(cat: string, xp: number, mat: string, config: SearchConfig): void {

        if (!Number.isFinite(xp) || !Number.isInteger(xp) || xp <= 0) {
            throw new Error(`Invalid XP level: ${xp}. XP must be a positive integer.`);
        }
        if (xp > ENGINE_LIMITS.MAX_XP_LEVEL) {
            throw new Error(`XP level ${xp} exceeds the maximum of ${ENGINE_LIMITS.MAX_XP_LEVEL}.`);
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
