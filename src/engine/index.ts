import { EnchantmentData, CalculationStats, SearchFrontier } from '../types/index.js';
import { LRUCache, ProbUtils } from '../utils/index.js';
import { Registry } from '../core/registry.js';
import { RegistryFactory } from '../core/factory.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { DistributionService } from './distribution.js';
import { SearchService } from './search.js';
import { StatAggregator } from './aggregator.js';

/**
 * Core math and logic engine for Minecraft Enchanting.
 * Orchestrates distribution calculation, best-first search, and statistics aggregation.
 */
export class EnchantEngine {
    static allEngines: Set<EnchantEngine> = new Set();
    
    private static readonly KEY_SHIFT_CAT = 0n;
    private static readonly KEY_SHIFT_MAT = 6n;
    private static readonly KEY_SHIFT_LEVEL = 12n;
    private static readonly KEY_SHIFT_GUARANTEED = 20n;
    private static readonly KEY_SHIFT_LIMIT = 28n;
    private static readonly KEY_SHIFT_RESULTS_LIMIT = 44n;
    private static readonly KEY_SHIFT_THRESHOLD = 60n;
    
    public registry: Registry;
    public comboCache = new LRUCache<bigint, SearchFrontier>(ENGINE_DEFAULTS.CACHE_SIZE_COMBO_OTHER);
    public bookComboCache = new LRUCache<bigint, SearchFrontier>(ENGINE_DEFAULTS.CACHE_SIZE_COMBO_BOOK);
    public statsCache = new LRUCache<bigint, CalculationStats>(ENGINE_DEFAULTS.CACHE_SIZE_STATS);
    public bestStatsCache = new LRUCache<bigint, { threshold: number, stats: CalculationStats }>(ENGINE_DEFAULTS.CACHE_SIZE_STATS);
    
    constructor(data: EnchantmentData, version: string) {
        this.registry = new Registry(data, RegistryFactory.build(data, version));
        EnchantEngine.allEngines.add(this);
    }

    private getPackedKey(cat: string, modLevel: number, mat: string, guaranteedFirst: string | null, limit: number, resultsLimit: number, threshold?: number): bigint {
        const catId = BigInt(this.registry.getCategoryId(cat));
        const matId = BigInt(this.registry.getMaterialId(mat));
        const guaranteedId = BigInt(this.registry.getEnchantId(guaranteedFirst ? guaranteedFirst.split(' ').slice(0, -1).join(' ') : ''));
        
        let key = catId << EnchantEngine.KEY_SHIFT_CAT;
        key |= matId << EnchantEngine.KEY_SHIFT_MAT;
        key |= BigInt(modLevel) << EnchantEngine.KEY_SHIFT_LEVEL;
        key |= (guaranteedFirst ? guaranteedId : BigInt(ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID)) << EnchantEngine.KEY_SHIFT_GUARANTEED;
        key |= BigInt(limit) << EnchantEngine.KEY_SHIFT_LIMIT;
        key |= BigInt(resultsLimit) << EnchantEngine.KEY_SHIFT_RESULTS_LIMIT;
        
        if (threshold !== undefined) {
            const tIdx = BigInt(Math.max(0, Math.min(255, Math.round(-Math.log10(threshold)))));
            key |= tIdx << EnchantEngine.KEY_SHIFT_THRESHOLD;
        }
        
        return key;
    }

    public static clearAllEngines(): void {
        this.clearAllCaches();
        this.allEngines.clear();
    }

    public static clearAllCaches(): void {
        DistributionService.clearCache();
        for (const engine of this.allEngines) {
            engine.comboCache.clear();
            engine.bookComboCache.clear();
            engine.statsCache.clear();
            engine.bestStatsCache.clear();
        }
    }

    public destroy(): void {
        this.comboCache.clear();
        this.bookComboCache.clear();
        this.statsCache.clear();
        this.bestStatsCache.clear();
        EnchantEngine.allEngines.delete(this);
    }

    public getModifiedLevelDist(xp: number, enchantability: number): { [level: number]: bigint } {
        return DistributionService.getModifiedLevelDist(xp, enchantability, this.registry);
    }

    public getEligibleListNumeric(cat: string, level: number, mat: string, bitset: bigint = 0n): number[] {
        const pool = this.registry.getEligiblePool(cat, level, mat);
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
        const limit = this.getSearchLimit(cat, threshold, maxIterations);
        const cacheKey = this.getPackedKey(cat, modLevel, mat, guaranteedFirst, limit, resultsLimit);
        const activeCache = cat === "book" ? this.bookComboCache : this.comboCache;
        
        const cached = activeCache.get(cacheKey);
        if (cached && cached.threshold <= threshold) return cached;

        const result = SearchService.calculateCombinations(
            this.registry, cat, modLevel, mat, guaranteedFirst, threshold, limit, cached, resultsLimit
        );
        
        activeCache.set(cacheKey, result);
        return result;
    }

    /**
     * Aggregates all statistics for a given enchantment attempt.
     */
    public async getFullStats(
        cat: string, 
        xp: number, 
        mat: string, 
        guaranteedFirst: string | null = null, 
        threshold: number = 0.0001,
        signal?: AbortSignal,
        onProgress?: (stats: CalculationStats) => void,
        useBestCache: boolean = false,
        maxIterations?: number,
        summaryLimit: number = ENGINE_DEFAULTS.MAX_RESULTS_SUMMARY,
        resultsLimit: number = ENGINE_DEFAULTS.MAX_RESULTS_SIZE,
        useCache: boolean = true
    ): Promise<CalculationStats> {
        const limit = maxIterations ?? (cat === "book" ? ENGINE_DEFAULTS.FALLBACK_LIMIT_BOOK : (threshold < 0.0001 ? ENGINE_DEFAULTS.FALLBACK_LIMIT_HIGH_RES : ENGINE_DEFAULTS.FALLBACK_LIMIT_LOW_RES));
        const baseKey = this.getPackedKey(cat, xp, mat, guaranteedFirst, limit, resultsLimit);
        const exactKey = this.getPackedKey(cat, xp, mat, guaranteedFirst, limit, resultsLimit, threshold);

        // Check exact stats cache
        if (this.statsCache.has(exactKey)) return this.statsCache.get(exactKey)!;

        // Check best-so-far stats cache (lower threshold than requested)
        if (useBestCache) {
            const best = this.bestStatsCache.get(baseKey);
            if (best && best.threshold <= threshold) return best.stats;
        }

        // Delegate aggregation to service
        const finalStats = await StatAggregator.getFullStats(
            this.registry, cat, xp, mat, guaranteedFirst, threshold, signal, onProgress, maxIterations, summaryLimit, resultsLimit,
            (ml) => (cat === "book" ? this.bookComboCache : this.comboCache).get(this.getPackedKey(cat, ml, mat, guaranteedFirst, limit, resultsLimit)),
            (ml, frontier) => (cat === "book" ? this.bookComboCache : this.comboCache).set(this.getPackedKey(cat, ml, mat, guaranteedFirst, limit, resultsLimit), frontier),
            useCache
        );

        // Persistent Caching
        this.statsCache.set(exactKey, finalStats);
        const existingBest = this.bestStatsCache.get(baseKey);
        if (!existingBest || threshold < existingBest.threshold) {
            this.bestStatsCache.set(baseKey, { threshold, stats: finalStats });
        }

        return finalStats;
    }

    private getSearchLimit(cat: string, threshold: bigint, maxIterations?: number): number {
        if (maxIterations !== undefined) return maxIterations;
        if (cat === "book") return ENGINE_DEFAULTS.FALLBACK_LIMIT_BOOK;
        return ProbUtils.toNumber(threshold) < 0.0001 ? ENGINE_DEFAULTS.FALLBACK_LIMIT_HIGH_RES : ENGINE_DEFAULTS.FALLBACK_LIMIT_LOW_RES;
    }
}
