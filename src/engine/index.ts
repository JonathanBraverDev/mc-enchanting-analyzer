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
    static allEngines: Set<WeakRef<EnchantEngine>> = new Set();


    public registry: RegistryState;
    public distCache = new Map<string, { [level: number]: bigint }>();
    public poolCache = new LRUCache<string, PackedEnchant[]>(200);
    public comboCache = new LRUCache<bigint, SearchFrontier>(ENGINE_DEFAULTS.CACHE_SIZE_COMBO_OTHER);
    public bookComboCache = new LRUCache<bigint, SearchFrontier>(ENGINE_DEFAULTS.CACHE_SIZE_COMBO_BOOK);
    public statsCache = new LRUCache<bigint, CalculationStats>(ENGINE_DEFAULTS.CACHE_SIZE_STATS);

    constructor(data: EnchantmentData, version: string) {
        this.registry = RegistryFactory.build(data, version);
        EnchantEngine.allEngines.add(new WeakRef(this));
    }

    private getPackedKey(cat: string, modLevel: number, mat: string, guaranteedFirst: string | null, limit: number, resultsLimit: number): bigint {
        const catId = getCategoryId(this.registry, cat);
        const matId = getMaterialId(this.registry, mat);
        const parsed = EnchantUtils.parse(guaranteedFirst, this.registry.data.constants.ROMAN_MAP);
        const guaranteedId = parsed ? getEnchantId(this.registry, parsed.name) : ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID;

        return KeyUtils.getPackedKey(catId, matId, modLevel, guaranteedId, limit, resultsLimit);
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
        const cacheKey = this.getPackedKey(cat, modLevel, mat, guaranteedFirst, limit, resultsLimit);
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
        const limit = getSearchLimit(cat, threshold, maxIterations);

        // Pre-resolve IDs once so closure only varies `ml`
        const catId = getCategoryId(this.registry, cat);
        const matId = getMaterialId(this.registry, mat);
        const parsedG = EnchantUtils.parse(guaranteedFirst, this.registry.data.constants.ROMAN_MAP);
        const guaranteedId = parsedG ? getEnchantId(this.registry, parsedG.name) : ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID;

        // Stats cache key excludes `limit` so a more precise result satisfies coarser requests
        const cacheKey = KeyUtils.getStatsKey(catId, matId, xp, guaranteedId, resultsLimit);

        // Check unified stats cache — return if cached result is already precise enough
        const cachedStats = this.statsCache.get(cacheKey);
        if (cachedStats && cachedStats.uncertainty <= threshold) return cachedStats;

        const activeCache = cat === "book" ? this.bookComboCache : this.comboCache;

        // Delegate aggregation to service (InternalSearchConfig adds cache accessors)
        const internalConfig: InternalSearchConfig = {
            threshold,
            signal,
            onProgress,
            maxIterations,
            summaryLimit,
            resultsLimit,
            getExtendedCache: (ml) => activeCache.get(KeyUtils.getPackedKey(catId, matId, ml, guaranteedId, limit, resultsLimit)),
            setExtendedCache: (ml, frontier) => activeCache.set(KeyUtils.getPackedKey(catId, matId, ml, guaranteedId, limit, resultsLimit), frontier),
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
