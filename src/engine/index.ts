import { EnchantmentData, CalculationStats } from '../core/types.js';
import { LRUCache, ProbUtils, PRECISION, ResultProcessor, AsyncUtils } from '../utils/index.js';
import { Registry } from '../core/registry.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { DistributionService } from './distribution.js';
import { SearchService, SearchFrontier } from './search.js';
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
    private static readonly KEY_SHIFT_THRESHOLD = 44n;
    
    public registry: Registry;
    public comboCache = new LRUCache<bigint, SearchFrontier>(ENGINE_DEFAULTS.CACHE_SIZE_COMBO_OTHER);
    public bookComboCache = new LRUCache<bigint, SearchFrontier>(ENGINE_DEFAULTS.CACHE_SIZE_COMBO_BOOK);
    public statsCache = new LRUCache<bigint, CalculationStats>(ENGINE_DEFAULTS.CACHE_SIZE_STATS);
    public bestStatsCache = new LRUCache<bigint, { threshold: number, stats: CalculationStats }>(ENGINE_DEFAULTS.CACHE_SIZE_STATS);
    
    constructor(data: EnchantmentData, version: string) {
        this.registry = new Registry(data, version);
        EnchantEngine.allEngines.add(this);
    }

    private getPackedKey(cat: string, modLevel: number, mat: string, guaranteedFirst: string | null, limit: number, threshold?: number): bigint {
        const catId = BigInt(this.registry.getCategoryId(cat));
        const matId = BigInt(this.registry.getMaterialId(mat));
        const guaranteedId = guaranteedFirst ? BigInt(this.registry.getEnchantId(guaranteedFirst.split(' ').slice(0, -1).join(' '))) : BigInt(ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID);
        
        let key = catId << EnchantEngine.KEY_SHIFT_CAT;
        key |= matId << EnchantEngine.KEY_SHIFT_MAT;
        key |= BigInt(modLevel) << EnchantEngine.KEY_SHIFT_LEVEL;
        key |= guaranteedId << EnchantEngine.KEY_SHIFT_GUARANTEED;
        key |= BigInt(limit) << EnchantEngine.KEY_SHIFT_LIMIT;
        
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
        return this.registry.getEligiblePool(cat, level, mat).filter(n => {
            const id = n >> 8;
            return (bitset & (1n << BigInt(id))) === 0n && (bitset & this.registry.conflictBitsets[id]) === 0n;
        });
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
        existingFrontier?: SearchFrontier,
        maxIterations?: number
    ): SearchFrontier {
        const limit = this.getSearchLimit(cat, threshold, maxIterations);
        const cacheKey = this.getPackedKey(cat, modLevel, mat, guaranteedFirst, limit);
        const activeCache = cat === "book" ? this.bookComboCache : this.comboCache;
        
        // Cache management remains in the engine
        const cached = activeCache.get(cacheKey);
        if (cached && cached.threshold <= threshold && !existingFrontier) return cached;

        const result = SearchService.calculateCombinations(
            this.registry, cat, modLevel, mat, guaranteedFirst, threshold, limit, existingFrontier || cached
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
        summaryLimit: number = ENGINE_DEFAULTS.MAX_RESULTS_SUMMARY
    ): Promise<CalculationStats> {
        const limit = maxIterations ?? (cat === "book" ? ENGINE_DEFAULTS.FALLBACK_LIMIT_BOOK : (threshold < 0.0001 ? ENGINE_DEFAULTS.FALLBACK_LIMIT_HIGH_RES : ENGINE_DEFAULTS.FALLBACK_LIMIT_LOW_RES));
        const baseKey = this.getPackedKey(cat, xp, mat, guaranteedFirst, limit);
        const exactKey = this.getPackedKey(cat, xp, mat, guaranteedFirst, limit, threshold);

        if (this.statsCache.has(exactKey)) return this.statsCache.get(exactKey)!;

        if (useBestCache) {
            const best = this.bestStatsCache.get(baseKey);
            if (best && best.threshold <= threshold) {
                return best.stats;
            }
        }

        const bThreshold = ProbUtils.toBigInt(threshold);
        const enchantability = this.registry.getEnchantability(mat, cat);
        const modDist = this.getModifiedLevelDist(xp, enchantability);
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);

        if (guaranteedFirst && !this.registry.isEnchantmentAchievable(guaranteedFirst, cat, mat, levels)) {
            return { ranks: {}, any: {}, count: {}, combos: {}, uncertainty: 1.0 };
        }

        const finalCombos = new Map<bigint, bigint>();
        const totalAnyMass = new Map<number, bigint>();
        const totalRankMass = new Map<number, bigint>();
        const totalCountMass = new Map<number, bigint>();

        const activeThreshold = guaranteedFirst ? bThreshold / 10n : bThreshold;

        let processedMProb = 0n;
        let totalUncertainty = 0n;
        let totalPrunedMass = 0n;
        
        let iterCount = 0;

        for (const ml of levels) {
            if (signal?.aborted) throw new Error("Calculation aborted");

            const mProb = modDist[ml];
            const result = this.calculateCombinations(cat, ml, mat, guaranteedFirst, activeThreshold, undefined, maxIterations);
            
            for (const [key, prob] of result.results) {
                const totalProb = ProbUtils.scale(prob, mProb);
                finalCombos.set(key, (finalCombos.get(key) || 0n) + totalProb);
            }

            const { anyMass, rankMass, countMass } = result;
            const addMass = (target: Map<number, bigint>, source: Map<number, bigint>) => {
                for (const [id, mass] of source) {
                    target.set(id, (target.get(id) || 0n) + ProbUtils.scale(mass, mProb));
                }
            };

            addMass(totalAnyMass, anyMass);
            addMass(totalRankMass, rankMass);
            addMass(totalCountMass, countMass);

            totalUncertainty += ProbUtils.scale(result.uncertainty, mProb);
            totalPrunedMass += ProbUtils.scale(result.prunedMass, mProb);

            processedMProb += mProb;
            if (++iterCount % 3 === 0) {
                if (onProgress) {
                    onProgress(ResultProcessor.summarize(finalCombos, totalUncertainty + (PRECISION - processedMProb), totalAnyMass, totalRankMass, totalCountMass, 0));
                }
                await AsyncUtils.yield();
            }
        }

        const finalStats = ResultProcessor.summarize(finalCombos, totalUncertainty, totalAnyMass, totalRankMass, totalCountMass, summaryLimit);
        finalStats.pruned = ProbUtils.toNumber(totalPrunedMass);
        this.statsCache.set(exactKey, finalStats);
        
        const best = this.bestStatsCache.get(baseKey);
        if (!best || threshold < best.threshold) {
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
