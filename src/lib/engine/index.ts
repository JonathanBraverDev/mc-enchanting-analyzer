import { EnchantmentData, CalculationStats, SearchFrontier, RegistryState, SearchConfig, InternalSearchConfig, PackedEnchant, EngineInstrumentation, CacheStats, ProgressUpdate } from '../types/index.js';
import { ProbUtils, KeyUtils, EnchantUtils, RomanUtils } from '../utils/index.js';
import { getMaterialId, getEnchantId, getEligiblePool, isCategoryAvailable, getEnchantability } from '../core/registry.js';
import { RegistryFactory } from '../core/factory.js';
import { ENGINE_LIMITS } from '../constants/engine.js';
import { getSearchLimit } from '../core/config.js';
import { CacheManager } from '../services/CacheManager.js';
import { KeyService } from '../services/KeyService.js';
import { PoolService } from '../services/PoolService.js';
import { SummaryService } from '../services/SummaryService.js';
import { DistributionService } from './distribution.js';
import { SearchService } from './search.js';
import { StatAggregator } from './aggregator.js';

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
    public getCacheMetrics(): { distCache: CacheStats; poolCache: CacheStats; frontierCache: CacheStats } {
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
     * Iteratively calculates enchantment combinations using a Best-First approach.
     */
    public async calculateCombinations(
        cat: string,
        modLevel: number,
        mat: string,
        guaranteedFirst: string | null = null,
        threshold: bigint = ProbUtils.toBigInt(0.0001),
        maxIterations?: number,
        resultsLimit: number = ENGINE_LIMITS.MAX_RESULTS_SIZE,
        instrumentation?: EngineInstrumentation
    ): Promise<SearchFrontier> {
        const limit = getSearchLimit(cat, ProbUtils.toNumber(threshold), maxIterations);
        const cacheKey = this.keyService.getPackedKey(this.registry, cat, modLevel, mat, guaranteedFirst);
        
        const cached = cat === "book" ? this.cache.getBook(this.registry.version, cacheKey) : this.cache.getCombo(this.registry.version, cacheKey);
        if (cached && cached.threshold <= threshold) return cached;

        const result = await this.searchService.calculateCombinations(
            this.registry, cat, modLevel, guaranteedFirst, cached, {
                threshold,
                limit,
                resultsLimit,
                instrumentation,
                // Timing is optionally passed via a dedicated tier/config if needed, but not here for brevity
            }
        );

        if (cat === "book") this.cache.setBook(this.registry.version, cacheKey, result);
        else this.cache.setCombo(this.registry.version, cacheKey, result);
        
        return result;
    }

    /**
     * Aggregates statistics using tiered progressive search, calling onTierComplete after each tier.
     */
    public async getFullStatsProgressive(
        cat: string,
        xp: number,
        mat: string,
        guaranteedFirst: string | null,
        tiers: Array<{ threshold: number; limit: number }>,
        onTierComplete: (stats: CalculationStats, tierIndex: number) => void,
        config?: Partial<SearchConfig>
    ): Promise<CalculationStats> {
        this.validateRequest(cat, xp, mat, guaranteedFirst);

        const {
            threshold = 0.0001,
            signal,
            onProgress,
            maxIterations,
            summaryLimit = ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_SIZE,
            useCache = true,
            instrumentation,
            timing
        } = config ?? {};

        const cacheKey = this.keyService.getStatsKey(this.registry, cat, xp, mat, guaranteedFirst);

        const cachedStats = this.cache.getStats(this.registry.version, cacheKey);
        const finestThreshold = tiers[tiers.length - 1].threshold;
        if (cachedStats && cachedStats.threshold <= finestThreshold) return cachedStats;

        const internalConfig: InternalSearchConfig = {
            threshold,
            signal,
            onProgress,
            maxIterations,
            summaryLimit,
            resultsLimit,
            useCache,
            instrumentation,
            timing,
            getCacheMetrics: () => ({ 
                cacheNodes: this.cache.getTotalCachedNodes(), 
                cacheResults: this.cache.getTotalCachedResults() 
            })
        };

        const wrappedOnTierComplete = (raw: any, tierIndex: number) => {
            const stats = SummaryService.summarize(raw.combos, raw.tracker, raw.anyMass, raw.rankMass, raw.countMass, summaryLimit, raw.threshold);
            stats.instrumentation = raw.instrumentation;
            stats.timing = raw.timing;
            
            onTierComplete(stats, tierIndex);
            const currentCached = this.cache.getStats(this.registry.version, cacheKey);
            if (!currentCached || stats.accuracy > currentCached.accuracy) {
                this.cache.setStats(this.registry.version, cacheKey, stats);
            }
        };

        const finalRaw = await this.statAggregator.getFullStatsTiered(
            this.registry, cat, xp, mat, guaranteedFirst, tiers, wrappedOnTierComplete, internalConfig
        );

        const finalStats = SummaryService.summarize(finalRaw.combos, finalRaw.tracker, finalRaw.anyMass, finalRaw.rankMass, finalRaw.countMass, summaryLimit, finalRaw.threshold);
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
     */
    public async getFullStats(
        cat: string,
        xp: number,
        mat: string,
        config: SearchConfig = {}
    ): Promise<CalculationStats> {
        this.validateRequest(cat, xp, mat, config.guaranteedFirst ?? null);

        const {
            guaranteedFirst = null,
            threshold = 0.0001,
            signal,
            onProgress,
            maxIterations,
            summaryLimit = ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_SIZE,
            useCache = true,
            instrumentation,
            timing
        } = config;

        const cacheKey = this.keyService.getStatsKey(this.registry, cat, xp, mat, guaranteedFirst);

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
                const pk = this.keyService.getPackedKey(this.registry, cat, ml, mat, guaranteedFirst);
                return cat === "book" ? this.cache.getBook(this.registry.version, pk) : this.cache.getCombo(this.registry.version, pk);
            },
            setExtendedCache: (ml, frontier) => {
                const pk = this.keyService.getPackedKey(this.registry, cat, ml, mat, guaranteedFirst);
                if (cat === "book") this.cache.setBook(this.registry.version, pk, frontier);
                else this.cache.setCombo(this.registry.version, pk, frontier);
            },
            instrumentation,
            timing,
            getCacheMetrics: () => ({ 
                cacheNodes: this.cache.getTotalCachedNodes(), 
                cacheResults: this.cache.getTotalCachedResults() 
            })
        };

        const finalRaw = await this.statAggregator.getFullStats(
            this.registry, cat, xp, mat, guaranteedFirst, internalConfig
        );

        const finalStats = SummaryService.summarize(finalRaw.combos, finalRaw.tracker, finalRaw.anyMass, finalRaw.rankMass, finalRaw.countMass, summaryLimit, finalRaw.threshold);
        finalStats.instrumentation = finalRaw.instrumentation;
        finalStats.timing = finalRaw.timing;

        const currentCached = this.cache.getStats(this.registry.version, cacheKey);
        if (!currentCached || finalStats.accuracy > currentCached.accuracy) {
            this.cache.setStats(this.registry.version, cacheKey, finalStats);
        }

        return finalStats;
    }


    private validateRequest(cat: string, xp: number, mat: string, guaranteedFirst: string | null): void {
        if (!Number.isFinite(xp) || xp <= 0) {
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
        if (guaranteedFirst) {
            this.validateGuaranteedFirst(cat, xp, mat, guaranteedFirst);
        }
    }

    /**
     * Validates that the requested guaranteedFirst enchantment is possible.
     */
    private validateGuaranteedFirst(cat: string, xp: number, mat: string, guaranteedFirst: string): void {
        const romanMap = this.registry.data.constants.ROMAN_MAP;
        const parsed = EnchantUtils.parse(guaranteedFirst, romanMap);
        if (!parsed) {
            throw new Error(`Invalid enchantment format: "${guaranteedFirst}". Expected "Name Rank".`);
        }

        const id = getEnchantId(this.registry, parsed.name);
        if (id === ENGINE_LIMITS.UNKNOWN_ENCHANT_ID) {
            throw new Error(`Unknown enchantment: "${parsed.name}".`);
        }

        const props = this.registry.resolvedRegistry[parsed.name];
        if (!props) {
            throw new Error(`Unknown enchantment: "${parsed.name}".`);
        }
        
        const maxLevel = Math.max(...Object.keys(props.levels).map(k => RomanUtils.getRomanValue(k, romanMap)));
        if (parsed.rank < 1 || parsed.rank > maxLevel) {
            const romanMax = RomanUtils.rankToRoman(maxLevel, romanMap);
            throw new Error(`Invalid rank: "${guaranteedFirst}" exceeds max level of ${romanMax}.`);
        }

        const pool = this.registry.versionPool.get(cat);
        if (!pool || !pool.includes(parsed.name)) {
            throw new Error(`Enchantment "${parsed.name}" is not applicable to category "${cat}".`);
        }

        const enchantability = getEnchantability(this.registry, mat, cat);
        const dist = this.getModifiedLevelDist(xp, enchantability);
        const levels = Object.keys(dist).map(Number);
        
        const isPossible = levels.some(ml => {
            const elPool = getEligiblePool(this.registry, cat, ml, this.cache, this.registry.version);
            return elPool.some(p => (p >> 8) === id && (p & 0xFF) === parsed.rank);
        });

        if (!isPossible) {
            throw new Error(`Enchantment "${guaranteedFirst}" is impossible to obtain for category "${cat}" at XP level ${xp} with "${mat}".`);
        }
    }
}

export { EngineFactory } from './factory.js';
