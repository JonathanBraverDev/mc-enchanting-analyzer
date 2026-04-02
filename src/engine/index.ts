import { EnchantmentData, CalculationStats, SearchFrontier, RegistryState, SearchConfig, InternalSearchConfig, PackedEnchant } from '../types/index.js';
import { LRUCache, ProbUtils, KeyUtils, EnchantUtils } from '../utils/index.js';
import { getCategoryId, getMaterialId, getEnchantId, getEligiblePool, isCategoryAvailable } from '../core/registry.js';
import { RegistryFactory } from '../core/factory.js';
import { ENGINE_DEFAULTS, getSearchLimit } from '../core/config.js';
import { DistributionService } from './distribution.js';
import { SearchService } from './search.js';
import { StatAggregator } from './aggregator.js';

/**
 * Core math and logic engine for Minecraft Enchanting.
 * Orchestrates distribution calculation, best-first search, and statistics aggregation.
 */
export class EnchantEngine {
    private static allEngines: Set<WeakRef<EnchantEngine>> = new Set();


    private _registry: RegistryState;
    get registry(): RegistryState { return this._registry; }
    private distCache = new Map<string, { [level: number]: bigint }>();
    private poolCache = new LRUCache<string, PackedEnchant[]>(200);
    private comboCache = new LRUCache<number, SearchFrontier>(ENGINE_DEFAULTS.CACHE_SIZE_COMBO_OTHER);
    private bookComboCache = new LRUCache<number, SearchFrontier>(ENGINE_DEFAULTS.CACHE_SIZE_COMBO_BOOK);
    private statsCache = new LRUCache<number, CalculationStats>(ENGINE_DEFAULTS.CACHE_SIZE_STATS);

    constructor(data: EnchantmentData, version: string) {
        this._registry = RegistryFactory.build(data, version);
        EnchantEngine.allEngines.add(new WeakRef(this));
    }

    /** Clears the combo and stats caches. Useful in tests to force fresh computation. */
    public resetCaches(): void {
        this.comboCache.clear();
        this.statsCache.clear();
    }

    /** Clears only the stats cache, leaving combo caches intact for cross-tier resumption tests. */
    public resetStatsCache(): void {
        this.statsCache.clear();
    }

    private getPackedKey(cat: string, modLevel: number, mat: string, guaranteedFirst: string | null): number {
        const catId = getCategoryId(this.registry, cat);
        const matId = getMaterialId(this.registry, mat);
        const parsed = EnchantUtils.parse(guaranteedFirst, this.registry.data.constants.ROMAN_MAP);
        const guaranteedId = parsed ? getEnchantId(this.registry, parsed.name) : ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID;

        return KeyUtils.getPackedKey(catId, matId, modLevel, guaranteedId);
    }

    public static clearAllEngines(): void {
        this.clearAllCaches();
        this.allEngines.clear();
    }

    public static clearAllCaches(): void {
        const dead: WeakRef<EnchantEngine>[] = [];
        for (const ref of this.allEngines) {
            const engine = ref.deref();
            if (engine) {
                engine.distCache.clear();
                engine.poolCache.clear();
                engine.comboCache.clear();
                engine.bookComboCache.clear();
                engine.statsCache.clear();
            } else {
                dead.push(ref);
            }
        }
        for (const ref of dead) {
            this.allEngines.delete(ref);
        }
    }

    public destroy(): void {
        this.distCache.clear();
        this.poolCache.clear();
        this.comboCache.clear();
        this.bookComboCache.clear();
        this.statsCache.clear();
        for (const ref of EnchantEngine.allEngines) {
            if (ref.deref() === this) {
                EnchantEngine.allEngines.delete(ref);
                break;
            }
        }
    }

    public getModifiedLevelDist(xp: number, enchantability: number): { [level: number]: bigint } {
        return DistributionService.getModifiedLevelDist(xp, enchantability, this.registry, this.distCache);
    }

    public getEligibleListNumeric(cat: string, level: number, mat: string, bitset: bigint = 0n): number[] {
        const pool = getEligiblePool(this.registry, cat, level, mat, this.poolCache);
        return pool.filter(p => (bitset & (1n << BigInt(p >> 8))) === 0n);
    }

    /**
     * Iteratively calculates enchantment combinations using a Best-First approach.
     */
    public calculateCombinations(
        cat: string,
        modLevel: number,
        mat: string,
        guaranteedFirst: string | null = null,
        threshold: bigint = ProbUtils.toBigInt(0.0001),
        maxIterations?: number,
        resultsLimit: number = ENGINE_DEFAULTS.MAX_RESULTS_SIZE
    ): SearchFrontier {
        const limit = getSearchLimit(cat, ProbUtils.toNumber(threshold), maxIterations);
        const cacheKey = this.getPackedKey(cat, modLevel, mat, guaranteedFirst);
        const activeCache = cat === "book" ? this.bookComboCache : this.comboCache;

        const cached = activeCache.get(cacheKey);
        if (cached && cached.threshold <= threshold) return cached;

        const result = SearchService.calculateCombinations(
            this.registry, cat, modLevel, mat, guaranteedFirst, threshold, limit, cached, resultsLimit, this.poolCache
        );

        activeCache.set(cacheKey, result);
        return result;
    }

    /**
     * Aggregates statistics using tiered progressive search, calling onTierComplete after each tier.
     * Checks and updates the stats cache the same way as getFullStats, but delegates frontier
     * management entirely to StatAggregator.getFullStatsTiered (no combo cache wiring).
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
        if (!Number.isFinite(xp) || xp <= 0) {
            throw new Error(`Invalid XP level: ${xp}. XP must be a positive integer.`);
        }
        if (xp > ENGINE_DEFAULTS.MAX_XP_LEVEL) {
            throw new Error(`XP level ${xp} exceeds the maximum of ${ENGINE_DEFAULTS.MAX_XP_LEVEL}.`);
        }
        if (!isCategoryAvailable(this.registry, cat)) {
            throw new Error(`Unknown or unavailable category: "${cat}" in version ${this.registry.version}.`);
        }
        if (getMaterialId(this.registry, mat) === ENGINE_DEFAULTS.UNKNOWN_MATERIAL_ID) {
            throw new Error(`Unknown material: "${mat}".`);
        }

        const {
            threshold = 0.0001,
            signal,
            onProgress,
            maxIterations,
            summaryLimit = ENGINE_DEFAULTS.MAX_RESULTS_SUMMARY,
            resultsLimit = ENGINE_DEFAULTS.MAX_RESULTS_SIZE,
            useCache = true
        } = config ?? {};

        const catId = getCategoryId(this.registry, cat);
        const matId = getMaterialId(this.registry, mat);
        const parsedG = EnchantUtils.parse(guaranteedFirst, this.registry.data.constants.ROMAN_MAP);
        const guaranteedId = parsedG ? getEnchantId(this.registry, parsedG.name) : ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID;

        const cacheKey = KeyUtils.getStatsKey(catId, matId, xp, guaranteedId);

        const cachedStats = this.statsCache.get(cacheKey);
        if (cachedStats) return cachedStats;

        // Tiered aggregator manages frontiers locally — no combo cache wiring needed
        const internalConfig: InternalSearchConfig = {
            threshold,
            signal,
            onProgress,
            maxIterations,
            summaryLimit,
            resultsLimit,
            useCache,
            distCache: this.distCache,
            poolCache: this.poolCache
        };

        // Wrap onTierComplete to cache each tier's result as it completes
        const wrappedOnTierComplete = (stats: CalculationStats, tierIndex: number) => {
            onTierComplete(stats, tierIndex);
            const currentCached = this.statsCache.get(cacheKey);
            if (!currentCached || stats.uncertainty < currentCached.uncertainty) {
                this.statsCache.set(cacheKey, stats);
            }
        };

        const finalStats = await StatAggregator.getFullStatsTiered(
            this.registry, cat, xp, mat, guaranteedFirst, tiers, wrappedOnTierComplete, internalConfig
        );

        // Only overwrite if new result is more precise (lower uncertainty)
        const currentCached = this.statsCache.get(cacheKey);
        if (!currentCached || finalStats.uncertainty < currentCached.uncertainty) {
            this.statsCache.set(cacheKey, finalStats);
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
        if (!Number.isFinite(xp) || xp <= 0) {
            throw new Error(`Invalid XP level: ${xp}. XP must be a positive integer.`);
        }
        if (xp > ENGINE_DEFAULTS.MAX_XP_LEVEL) {
            throw new Error(`XP level ${xp} exceeds the maximum of ${ENGINE_DEFAULTS.MAX_XP_LEVEL}.`);
        }
        if (!isCategoryAvailable(this.registry, cat)) {
            throw new Error(`Unknown or unavailable category: "${cat}" in version ${this.registry.version}.`);
        }
        if (getMaterialId(this.registry, mat) === ENGINE_DEFAULTS.UNKNOWN_MATERIAL_ID) {
            throw new Error(`Unknown material: "${mat}".`);
        }

        const {
            guaranteedFirst = null,
            threshold = 0.0001,
            signal,
            onProgress,
            maxIterations,
            summaryLimit = ENGINE_DEFAULTS.MAX_RESULTS_SUMMARY,
            resultsLimit = ENGINE_DEFAULTS.MAX_RESULTS_SIZE,
            useCache = true
        } = config;
        // Pre-resolve IDs once so closure only varies `ml`
        const catId = getCategoryId(this.registry, cat);
        const matId = getMaterialId(this.registry, mat);
        const parsedG = EnchantUtils.parse(guaranteedFirst, this.registry.data.constants.ROMAN_MAP);
        const guaranteedId = parsedG ? getEnchantId(this.registry, parsedG.name) : ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID;

        // Stats cache key is request-independent so results are reused across queries
        const cacheKey = KeyUtils.getStatsKey(catId, matId, xp, guaranteedId);

        // Check unified stats cache
        const cachedStats = this.statsCache.get(cacheKey);
        if (cachedStats) return cachedStats;

        const activeCache = cat === "book" ? this.bookComboCache : this.comboCache;

        // Delegate aggregation to service (InternalSearchConfig adds cache accessors)
        const internalConfig: InternalSearchConfig = {
            threshold,
            signal,
            onProgress,
            maxIterations,
            summaryLimit,
            resultsLimit,
            getExtendedCache: (ml) => activeCache.get(KeyUtils.getPackedKey(catId, matId, ml, guaranteedId)),
            setExtendedCache: (ml, frontier) => activeCache.set(KeyUtils.getPackedKey(catId, matId, ml, guaranteedId), frontier),
            useCache,
            distCache: this.distCache,
            poolCache: this.poolCache
        };
        const finalStats = await StatAggregator.getFullStats(
            this.registry, cat, xp, mat, guaranteedFirst, internalConfig
        );

        // Only overwrite if new result is more precise (lower uncertainty)
        if (!cachedStats || finalStats.uncertainty < cachedStats.uncertainty) {
            this.statsCache.set(cacheKey, finalStats);
        }

        return finalStats;
    }

}
