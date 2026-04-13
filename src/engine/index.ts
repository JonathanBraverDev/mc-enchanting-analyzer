import { EnchantmentData, CalculationStats, SearchFrontier, RegistryState, SearchConfig, InternalSearchConfig, PackedEnchant, EngineInstrumentation } from '../types/index.js';
import { LRUCache, ProbUtils, KeyUtils, EnchantUtils, RomanUtils } from '../utils/index.js';
import { getCategoryId, getMaterialId, getEnchantId, getEligiblePool, isCategoryAvailable, getEnchantability } from '../core/registry.js';
import { RegistryFactory } from '../core/factory.js';
import { ENGINE_LIMITS } from '../constants/engine.js';
import { getSearchLimit } from '../core/config.js';
import { cacheManager } from '../services/index.js';
import { DistributionService } from './distribution.js';
import { SearchService } from './search.js';
import { StatAggregator } from './aggregator.js';

/**
 * Core math and logic engine for Minecraft Enchanting.
 * Orchestrates distribution calculation, best-first search, and statistics aggregation.
 */
export class EnchantEngine {
    private _registry: RegistryState;
    get registry(): RegistryState { return this._registry; }

    constructor(data: EnchantmentData, version: string) {
        this._registry = RegistryFactory.build(data, version);
    }

    /** Clears all engine-level caches. */
    public resetCaches(): void {
        cacheManager.clearAll();
    }

    /** Clears only the stats cache. */
    public resetStatsCache(): void {
        cacheManager.clearStats();
    }

    private getPackedKey(cat: string, modLevel: number, mat: string, guaranteedFirst: string | null): number {
        const catId = getCategoryId(this.registry, cat);
        const matId = getMaterialId(this.registry, mat);
        const parsed = EnchantUtils.parse(guaranteedFirst, this.registry.data.constants.ROMAN_MAP);
        const guaranteedId = parsed ? getEnchantId(this.registry, parsed.name) : ENGINE_LIMITS.UNKNOWN_ENCHANT_ID;

        return KeyUtils.getPackedKey(catId, matId, modLevel, guaranteedId);
    }

    public destroy(): void {
        // Shared caches are not cleared on destroy unless explicitly requested via resetCaches()
    }

    public getModifiedLevelDist(xp: number, enchantability: number, _instrumentation?: EngineInstrumentation): { [level: number]: bigint } {
        return DistributionService.getModifiedLevelDist(this.registry.version, xp, enchantability, this._registry, cacheManager);
    }

    public getEligibleListNumeric(cat: string, level: number, bitset: bigint = 0n): number[] {
        const pool = getEligiblePool(this.registry, cat, level, cacheManager, this.registry.version);
        return pool.filter(p => (bitset & (1n << BigInt(p >> 8))) === 0n);
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
        const cacheKey = this.getPackedKey(cat, modLevel, mat, guaranteedFirst);
        
        const cached = cat === "book" ? cacheManager.getBook(this.registry.version, cacheKey) : cacheManager.getCombo(this.registry.version, cacheKey);
        if (cached && cached.threshold <= threshold) return cached;

        const result = await SearchService.calculateCombinations(
            this.registry, cat, modLevel, mat, guaranteedFirst, threshold, limit, cached, resultsLimit, undefined, undefined, instrumentation
        );

        if (cat === "book") cacheManager.setBook(this.registry.version, cacheKey, result);
        else cacheManager.setCombo(this.registry.version, cacheKey, result);
        
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

        const catId = getCategoryId(this.registry, cat);
        const matId = getMaterialId(this.registry, mat);
        const parsedG = EnchantUtils.parse(guaranteedFirst, this.registry.data.constants.ROMAN_MAP);
        const guaranteedId = parsedG ? getEnchantId(this.registry, parsedG.name) : ENGINE_LIMITS.UNKNOWN_ENCHANT_ID;

        const cacheKey = KeyUtils.getStatsKey(catId, matId, xp, guaranteedId);

        const cachedStats = cacheManager.getStats(this.registry.version, cacheKey);
        const finestThreshold = tiers[tiers.length - 1].threshold;
        if (cachedStats && cachedStats.threshold <= finestThreshold) return cachedStats;

        if (guaranteedFirst) {
            this.validateGuaranteedFirst(cat, xp, mat, guaranteedFirst);
        }

        const internalConfig: InternalSearchConfig = {
            threshold,
            signal,
            onProgress,
            maxIterations,
            summaryLimit,
            resultsLimit,
            useCache,
            instrumentation,
            timing
        };

        const wrappedOnTierComplete = (stats: CalculationStats, tierIndex: number) => {
            onTierComplete(stats, tierIndex);
            const currentCached = cacheManager.getStats(this.registry.version, cacheKey);
            if (!currentCached || stats.accuracy > currentCached.accuracy) {
                cacheManager.setStats(this.registry.version, cacheKey, stats);
            }
        };

        const finalStats = await StatAggregator.getFullStatsTiered(
            this.registry, cat, xp, mat, guaranteedFirst, tiers, wrappedOnTierComplete, internalConfig
        );

        const currentCached = cacheManager.getStats(this.registry.version, cacheKey);
        if (!currentCached || finalStats.accuracy > currentCached.accuracy) {
            cacheManager.setStats(this.registry.version, cacheKey, finalStats);
        }

        return finalStats;
    }

    public getCacheMetrics(): { distCache: CacheStats; poolCache: CacheStats; frontierCache: CacheStats } {
        return cacheManager.getEngineMetrics();
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
        if (xp > ENGINE_LIMITS.MAX_XP_LEVEL) {
            throw new Error(`XP level ${xp} exceeds the maximum of ${ENGINE_LIMITS.MAX_XP_LEVEL}.`);
        }
        if (!isCategoryAvailable(this.registry, cat)) {
            throw new Error(`Unknown or unavailable category: "${cat}" in version ${this.registry.version}.`);
        }
        if (getMaterialId(this.registry, mat) === ENGINE_LIMITS.UNKNOWN_MATERIAL_ID) {
            throw new Error(`Unknown material: "${mat}".`);
        }

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

        const catId = getCategoryId(this.registry, cat);
        const matId = getMaterialId(this.registry, mat);
        const parsedG = EnchantUtils.parse(guaranteedFirst, this.registry.data.constants.ROMAN_MAP);
        const guaranteedId = parsedG ? getEnchantId(this.registry, parsedG.name) : ENGINE_LIMITS.UNKNOWN_ENCHANT_ID;

        const cacheKey = KeyUtils.getStatsKey(catId, matId, xp, guaranteedId);

        const cachedStats = cacheManager.getStats(this.registry.version, cacheKey);
        if (cachedStats && cachedStats.threshold <= threshold) return cachedStats;

        if (guaranteedFirst) {
            this.validateGuaranteedFirst(cat, xp, mat, guaranteedFirst);
        }

        const internalConfig: InternalSearchConfig = {
            threshold,
            signal,
            onProgress,
            maxIterations,
            summaryLimit,
            resultsLimit,
            getExtendedCache: (ml) => cat === "book" ? cacheManager.getBook(this.registry.version, KeyUtils.getPackedKey(catId, matId, ml, guaranteedId)) : cacheManager.getCombo(this.registry.version, KeyUtils.getPackedKey(catId, matId, ml, guaranteedId)),
            setExtendedCache: (ml, frontier) => {
                if (cat === "book") cacheManager.setBook(this.registry.version, KeyUtils.getPackedKey(catId, matId, ml, guaranteedId), frontier);
                else cacheManager.setCombo(this.registry.version, KeyUtils.getPackedKey(catId, matId, ml, guaranteedId), frontier);
            },
            instrumentation,
            timing,
            getCacheMetrics: () => this.getCacheMetrics() as any
        };
        const finalStats = await StatAggregator.getFullStats(
            this.registry, cat, xp, mat, guaranteedFirst, internalConfig
        );

        const currentCached = cacheManager.getStats(this.registry.version, cacheKey);
        if (!currentCached || finalStats.accuracy > currentCached.accuracy) {
            cacheManager.setStats(this.registry.version, cacheKey, finalStats);
        }

        return finalStats;
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
            const elPool = getEligiblePool(this.registry, cat, ml, this.poolCache);
            return elPool.some(p => (p >> 8) === id && (p & 0xFF) === parsed.rank);
        });

        if (!isPossible) {
            throw new Error(`Enchantment "${guaranteedFirst}" is impossible to obtain for category "${cat}" at XP level ${xp} with "${mat}".`);
        }
    }

}
