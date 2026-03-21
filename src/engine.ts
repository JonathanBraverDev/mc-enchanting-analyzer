import { EnchantmentData, CalculationStats } from './types.js';
import { BinaryHeap, RomanUtils, PRECISION, ProbUtils, LRUCache, PackedEnchant, PackedCombo, ComboUtils, ResultProcessor, PackedNode, AsyncUtils, BitwiseUtils } from './utils/index.js';
import { Registry } from './registry.js';
import { ENGINE_DEFAULTS } from './config.js';

/**
 * Represents the state of a search for enchantment combinations.
 * Can be used to resume calculations at a higher resolution.
 */
export interface SearchFrontier {
    queue: BinaryHeap<PackedNode>;
    results: Map<PackedCombo, bigint>;
    uncertainty: bigint;
    cumulativeAccountedMass: bigint;
    threshold: bigint;
}

/**
 * Core math and logic engine for Minecraft Enchanting.
 */
export class EnchantEngine {
    static distCache = new Map<string, { [level: number]: bigint }>();
    static allEngines: Set<EnchantEngine> = new Set();
    
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
        const guaranteedId = guaranteedFirst ? BigInt(this.registry.getEnchantId(RomanUtils.getBaseName(guaranteedFirst, this.registry.data.constants.ROMAN_MAP))) : BigInt(ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID);
        
        let key = catId;
        key |= matId << 6n;
        key |= BigInt(modLevel) << 12n;
        key |= guaranteedId << 20n;
        key |= BigInt(limit) << 28n;
        
        if (threshold !== undefined) {
            const tIdx = BigInt(Math.max(0, Math.min(255, Math.round(-Math.log10(threshold)))));
            key |= tIdx << 44n;
        }
        
        return key;
    }

    /**
     * Clears all caches across all active engine instances.
     */
    public static clearAllCaches(): void {
        this.distCache.clear();
        for (const engine of this.allEngines) {
            engine.comboCache.clear();
            engine.bookComboCache.clear();
            engine.statsCache.clear();
            engine.bestStatsCache.clear();
        }
    }

    /**
     * Calculates the probability distribution of Modified Levels.
     */
    public getModifiedLevelDist(xp: number, enchantability: number): { [level: number]: bigint } {
        const mech = this.registry.mechanics;
        const key = `${xp}@${enchantability}@${mech.enchantability_bonus_divisor}@${mech.random_bonus_range}`;
        if (EnchantEngine.distCache.has(key)) return EnchantEngine.distCache.get(key)!;

        // 1.0 in BigInt fixed-point
        if (enchantability <= 0) return { [xp]: PRECISION };
        
        const div = mech.enchantability_bonus_divisor || 4;
        const rngRange = mech.random_bonus_range || 0.15;

        const N = Math.floor(enchantability / div) + 1;
        
        const baseDist: { [val: number]: bigint } = {};
        const nSq = BigInt(N * N);
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < N; j++) {
                const val = xp + i + j + 1;
                baseDist[val] = (baseDist[val] || 0n) + (PRECISION / nSq);
            }
        }

        const finalDist: { [modVal: number]: bigint } = {};
        const steps = ENGINE_DEFAULTS.RNG_STEPS_FOR_DISTRIBUTION;
        const stepSize = rngRange / (steps - 1);
        const stepsSq = BigInt(steps * steps);
        
        for (let [baseStr, bProb] of Object.entries(baseDist)) {
            const base = Number(baseStr);
            for (let i = 0; i < steps; i++) {
                const bonusI = i * stepSize;
                for (let j = 0; j < steps; j++) {
                    const bonus = bonusI + (j * stepSize) - rngRange;
                    const modVal = Math.max(1, Math.floor(base * (1 + bonus) + 0.5));
                    finalDist[modVal] = (finalDist[modVal] || 0n) + (bProb / stepsSq);
                }
            }
        }

        EnchantEngine.distCache.set(key, finalDist);
        return finalDist;
    }



    /**
     * Gets a list of enchants eligible for a specific modified level, filtered by a bitset.
     */
    public getEligibleListNumeric(cat: string, level: number, mat: string, bitset: bigint = 0n): number[] {
        return this.registry.getEligiblePool(cat, level, mat).filter(n => {
            const id = ComboUtils.getEnchantId(n);
            return (bitset & BitwiseUtils.getBitset(id)) === 0n && (bitset & this.registry.conflictBitsets[id]) === 0n;
        });
    }

    /**
     * Iteratively calculates enchantment combinations using a Best-First approach.
     * Supports resuming from a previous SearchFrontier if higher accuracy is needed.
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
        const limit = maxIterations ?? (cat === "book" ? ENGINE_DEFAULTS.FALLBACK_LIMIT_BOOK : (ProbUtils.toNumber(threshold) < 0.0001 ? ENGINE_DEFAULTS.FALLBACK_LIMIT_HIGH_RES : ENGINE_DEFAULTS.FALLBACK_LIMIT_LOW_RES));
        const cacheKey = this.getPackedKey(cat, modLevel, mat, guaranteedFirst, limit);
        const activeCache = cat === "book" ? this.bookComboCache : this.comboCache;
        
        const cached = activeCache.get(cacheKey);
        if (cached && cached.threshold <= threshold && !existingFrontier) return cached;

        let results: Map<PackedCombo, bigint>;
        let uncertainty: bigint;
        let cumulativeAccountedMass: bigint;
        let queue: BinaryHeap<PackedNode>;

        const romanMap = this.registry.data.constants.ROMAN_MAP;
        const guaranteedFirstBase = guaranteedFirst ? RomanUtils.getBaseName(guaranteedFirst, romanMap) : null;
        let guaranteedFirstId: number | null = null;
        if (guaranteedFirstBase) {
            const tempId = this.registry.getEnchantId(guaranteedFirstBase);
            if (tempId !== ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID) guaranteedFirstId = tempId;
        }

        if (existingFrontier) {
            results = new Map(existingFrontier.results);
            uncertainty = existingFrontier.uncertainty;
            cumulativeAccountedMass = existingFrontier.cumulativeAccountedMass;
            queue = existingFrontier.queue.clone();
        } else if (cached && cached.threshold > threshold) {
            results = new Map(cached.results);
            uncertainty = cached.uncertainty;
            cumulativeAccountedMass = cached.cumulativeAccountedMass;
            queue = cached.queue.clone();
        } else {
            results = new Map();
            uncertainty = 0n;
            cumulativeAccountedMass = 0n;
            
            const guaranteedFirstRank = guaranteedFirst ? RomanUtils.getRomanValue(guaranteedFirst.split(' ').pop()!, romanMap) : null;
            const guaranteedFirstFull = guaranteedFirstId !== null && guaranteedFirstRank !== null ? (guaranteedFirstId << 8 | guaranteedFirstRank) : null;

            queue = new BinaryHeap<PackedNode>((item) => item.meta);
            
            const initialPacked = guaranteedFirstFull !== null ? ComboUtils.pack([guaranteedFirstFull], guaranteedFirstId) : 0n;
            const initialBitset = guaranteedFirstId !== null ? (1n << BigInt(guaranteedFirstId)) : 0n;

            queue.push({ 
                packedChosen: initialPacked,
                meta: (initialBitset << 8n) | BigInt(modLevel),
                prob: PRECISION 
            });
        }

        let iterations = 0;

        const initialPool = this.registry.getEligiblePool(cat, modLevel, mat);
        if (initialPool.length === 0) {
            return { queue: new BinaryHeap(), results: new Map(), uncertainty: 0n, cumulativeAccountedMass: PRECISION, threshold };
        }

        const poolWeights = initialPool.map(e => this.registry.weightMap[e >> 8]);
        const initialTotalWeight = poolWeights.reduce((a, b) => a + b, 0);

        while (queue.size() > 0 && iterations < limit && cumulativeAccountedMass < (PRECISION - (PRECISION / ENGINE_DEFAULTS.MASS_ACCOUNTED_THRESHOLD_DENOMINATOR))) {
            const next = queue.peek()!;
            if (next.prob < threshold / 10n) break;

            iterations++;
            const current = queue.pop()!;
            const currentBitset = current.meta >> 8n;
            const currentLevel = Number(current.meta & 0xFFn);
            const currentCount = ComboUtils.getCount(current.packedChosen);
            
            if (currentCount === 0) {
                const pBase = current.prob / BigInt(initialTotalWeight);
                for (let i = 0; i < initialPool.length; i++) {
                    const e = initialPool[i];
                    queue.push({ 
                        packedChosen: ComboUtils.pack([e], guaranteedFirstId), 
                        meta: (BitwiseUtils.getBitset(ComboUtils.getEnchantId(e)) << 8n) | BigInt(modLevel),
                        prob: BigInt(poolWeights[i]) * pBase 
                    });
                }
                continue;
            }

            const probContinueNum = (cat === "book" && !this.registry.multiEnchantBooks) ? 0 : Math.min((currentLevel + 1) / ENGINE_DEFAULTS.MAX_MODIFIED_LEVEL_FOR_CONTINUING, 1.0);
            const probContinue = ProbUtils.toBigInt(probContinueNum);

            if (probContinue <= 0n) {
                results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + current.prob);
                cumulativeAccountedMass += current.prob;
                continue;
            }

            const probStop = ProbUtils.scale(current.prob, (PRECISION - probContinue));
            results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probStop);
            cumulativeAccountedMass += probStop;

            const probMovingForward = ProbUtils.scale(current.prob, probContinue);
            if (probMovingForward < threshold / ENGINE_DEFAULTS.PRUNE_THRESHOLD_DENOMINATOR || currentCount >= ENGINE_DEFAULTS.MAX_ENCHANTS_PER_ITEM) {
                uncertainty += probMovingForward;
                continue;
            }

            let currentTotalWeight = 0;
            const currentEligible: PackedEnchant[] = [];
            const currentWeights: number[] = [];

            for (let i = 0; i < initialPool.length; i++) {
                const e = initialPool[i];
                const id = ComboUtils.getEnchantId(e);
                if ((currentBitset & (1n << BigInt(id))) !== 0n) continue;
                if ((currentBitset & this.registry.conflictBitsets[id]) !== 0n) continue;

                currentEligible.push(e);
                currentWeights.push(poolWeights[i]);
                currentTotalWeight += poolWeights[i];
            }

            if (currentTotalWeight === 0) {
                results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probMovingForward);
                cumulativeAccountedMass += probMovingForward;
                continue;
            }

            const nextLevel = currentCount >= 1 ? Math.floor(currentLevel / 2) : currentLevel;
            const pNextBase = probMovingForward / BigInt(currentTotalWeight);
            const currentChosen = ComboUtils.unpack(current.packedChosen);

            for (let i = 0; i < currentEligible.length; i++) {
                const e = currentEligible[i];
                queue.push({
                    packedChosen: ComboUtils.pack([...currentChosen, e], guaranteedFirstId),
                    meta: ((currentBitset | BitwiseUtils.getBitset(ComboUtils.getEnchantId(e))) << 8n) | BigInt(nextLevel),
                    prob: BigInt(currentWeights[i]) * pNextBase
                });
            }
        }

        let frontierUncertainty = 0n;
        const outResults = new Map(results);
        for (const item of queue.items) {
            frontierUncertainty += item.prob;
            if (item.packedChosen !== 0n) outResults.set(item.packedChosen, (outResults.get(item.packedChosen) || 0n) + item.prob);
        }

        const totalUncertainty = uncertainty + frontierUncertainty;
        const out = { queue, results, uncertainty, cumulativeAccountedMass, threshold };
        
        activeCache.set(cacheKey, out);
        return { ...out, results: outResults, uncertainty: totalUncertainty }; 
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
        maxIterations?: number
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

        if (guaranteedFirst) {
            const ench = this.registry.getEnchantability(mat, cat);
            const dist = this.getModifiedLevelDist(xp, ench);
            let possible = false;
            for (const ml of Object.keys(dist).map(Number)) {
                const pool = this.registry.getEligiblePool(cat, ml, mat);
                if (pool.some(n => this.registry.getFullEnchantName(n) === guaranteedFirst)) {
                    possible = true;
                    break;
                }
            }
            if (!possible) {
                return { ranks: {}, any: {}, count: {}, combos: {}, uncertainty: 1.0 };
            }
        }

        const enchantability = this.registry.getEnchantability(mat, cat);
        const modDist = this.getModifiedLevelDist(xp, enchantability);
        const finalCombos = new Map<PackedCombo, bigint>();

        const activeThreshold = guaranteedFirst ? bThreshold / 10n : bThreshold;

        let processedMProb = 0n;
        let totalUncertainty = 0n;
        
        const levels = Object.keys(modDist).map(Number).sort((a, b) => b - a);
        let iterCount = 0;

        for (const ml of levels) {
            if (signal?.aborted) throw new Error("Calculation aborted");

            const mProb = modDist[ml];
            const result = this.calculateCombinations(cat, ml, mat, guaranteedFirst, activeThreshold, undefined, maxIterations);
            
            for (const [key, prob] of result.results) {
                const totalProb = ProbUtils.scale(prob, mProb);
                finalCombos.set(key, (finalCombos.get(key) || 0n) + totalProb);
            }
            totalUncertainty += ProbUtils.scale(result.uncertainty, mProb);

            processedMProb += mProb;
            if (++iterCount % 3 === 0) {
                if (onProgress) {
                    onProgress(ResultProcessor.summarize(finalCombos, totalUncertainty + (PRECISION - processedMProb)));
                }
                await AsyncUtils.yield();
            }
        }

        const finalStats = ResultProcessor.summarize(finalCombos, totalUncertainty);
        this.statsCache.set(exactKey, finalStats);
        
        const best = this.bestStatsCache.get(baseKey);
        if (!best || threshold < best.threshold) {
            this.bestStatsCache.set(baseKey, { threshold, stats: finalStats });
        }

        return finalStats;
    }
}
