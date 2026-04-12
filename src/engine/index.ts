import { EnchantmentData, CalculationStats, SearchFrontier, RegistryState, SearchConfig, InternalSearchConfig, PackedEnchant, EngineInstrumentation } from '../types/index.js';
import { LRUCache, ProbUtils, KeyUtils, EnchantUtils, RomanUtils } from '../utils/index.js';
import { getCategoryId, getMaterialId, getEnchantId, getEligiblePool, isCategoryAvailable, getEnchantability } from '../core/registry.js';
import { RegistryFactory } from '../core/factory.js';
import { ENGINE_LIMITS } from '../constants/engine.js';
import { getSearchLimit } from '../core/config.js';
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
    private comboCache = new LRUCache<number, SearchFrontier>(128); // Will be centralized in CacheManager
    private bookComboCache = new LRUCache<number, SearchFrontier>(64);
    private statsCache = new LRUCache<number, CalculationStats>(8);

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
        const guaranteedId = parsed ? getEnchantId(this.registry, parsed.name) : ENGINE_LIMITS.UNKNOWN_ENCHANT_ID;

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

    public getModifiedLevelDist(xp: number, enchantability: number, _instrumentation?: EngineInstrumentation): { [level: number]: bigint } {
        return DistributionService.getModifiedLevelDist(xp, enchantability, this._registry, this.distCache);
    }

    public getEligibleListNumeric(cat: string, level: number, bitset: bigint = 0n): number[] {
        const pool = getEligiblePool(this.registry, cat, level, this.poolCache);
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
        const activeCache = cat === "book" ? this.bookComboCache : this.comboCache;

        const cached = activeCache.get(cacheKey);
        if (cached && cached.threshold <= threshold) return cached;

        const result = await SearchService.calculateCombinations(
            this.registry, cat, modLevel, mat, guaranteedFirst, threshold, limit, cached, resultsLimit, this.poolCache, undefined, instrumentation
        );

        activeCache.set(cacheKey, result);
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

        const cachedStats = this.statsCache.get(cacheKey);
        if (cachedStats) return cachedStats;

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
            distCache: this.distCache,
            poolCache: this.poolCache,
            instrumentation,
            timing
        };

        const wrappedOnTierComplete = (stats: CalculationStats, tierIndex: number) => {
            onTierComplete(stats, tierIndex);
            const currentCached = this.statsCache.get(cacheKey);
            if (!currentCached || stats.accuracy > currentCached.accuracy) {
                this.statsCache.set(cacheKey, stats);
            }
        };

        const finalStats = await StatAggregator.getFullStatsTiered(
            this.registry, cat, xp, mat, guaranteedFirst, tiers, wrappedOnTierComplete, internalConfig
        );

        const currentCached = this.statsCache.get(cacheKey);
        if (!currentCached || finalStats.accuracy > currentCached.accuracy) {
            this.statsCache.set(cacheKey, finalStats);
        }

        return finalStats;
    }

    public getCacheMetrics(): { cacheNodes: number; cacheResults: number } {
        let cacheNodes = 0;
        let cacheResults = 0;

        for (const frontier of this.comboCache.values()) {
            cacheNodes += frontier.queue.size();
            cacheResults += frontier.results.size;
        }
        for (const frontier of this.bookComboCache.values()) {
            cacheNodes += frontier.queue.size();
            cacheResults += frontier.results.size;
        }

        return { cacheNodes, cacheResults };
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

        const cachedStats = this.statsCache.get(cacheKey);
        if (cachedStats) return cachedStats;

        const activeCache = cat === "book" ? this.bookComboCache : this.comboCache;

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
            getExtendedCache: (ml) => activeCache.get(KeyUtils.getPackedKey(catId, matId, ml, guaranteedId)),
            setExtendedCache: (ml, frontier) => activeCache.set(KeyUtils.getPackedKey(catId, matId, ml, guaranteedId), frontier),
            distCache: this.distCache,
            poolCache: this.poolCache,
            instrumentation,
            timing,
            getCacheMetrics: () => this.getCacheMetrics()
        };
        const finalStats = await StatAggregator.getFullStats(
            this.registry, cat, xp, mat, guaranteedFirst, internalConfig
        );

        const currentCached = this.statsCache.get(cacheKey);
        if (!currentCached || finalStats.accuracy > currentCached.accuracy) {
            this.statsCache.set(cacheKey, finalStats);
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
