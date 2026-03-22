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
    prunedMass: bigint;
    threshold: bigint;
}

/**
 * Core math and logic engine for Minecraft Enchanting.
 */
export class EnchantEngine {
    static distCache = new Map<string, { [level: number]: bigint }>();
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
        const guaranteedId = guaranteedFirst ? BigInt(this.registry.getEnchantId(RomanUtils.getBaseName(guaranteedFirst, this.registry.data.constants.ROMAN_MAP))) : BigInt(ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID);
        
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

    /**
     * Clears all caches and unregisters all active engine instances.
     * Important for preventing memory leaks in test suites.
     */
    public static clearAllEngines(): void {
        this.clearAllCaches();
        this.allEngines.clear();
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
     * Unregisters this engine instance from the global set and clears its local caches.
     */
    public destroy(): void {
        this.comboCache.clear();
        this.bookComboCache.clear();
        this.statsCache.clear();
        this.bestStatsCache.clear();
        EnchantEngine.allEngines.delete(this);
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

        const frontier = this.initializeSearchFrontier(cat, modLevel, guaranteedFirst, cached, existingFrontier, threshold);
        let { results, uncertainty, cumulativeAccountedMass, prunedMass, queue } = frontier;
        
        const guaranteedFirstId = this.getGuaranteedFirstId(guaranteedFirst);

        let iterations = 0;

        const initialPool = this.registry.getEligiblePool(cat, modLevel, mat);
        if (initialPool.length === 0) {
            return { queue: new BinaryHeap(), results: new Map(), uncertainty: 0n, cumulativeAccountedMass: PRECISION, prunedMass: 0n, threshold };
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
                this.processInitialNode(current, modLevel, guaranteedFirstId, initialPool, poolWeights, initialTotalWeight, queue);
                continue;
            }

            const probContinueNum = (cat === "book" && !this.registry.multiEnchantBooks) ? 0 : Math.min((currentLevel + 1) / ENGINE_DEFAULTS.MAX_MODIFIED_LEVEL_FOR_CONTINUING, 1.0);
            const probContinue = ProbUtils.toBigInt(probContinueNum);

            const deltas = this.processSearchNode(
                current, cat, guaranteedFirstId, initialPool, poolWeights, threshold, results, queue
            );
            
            uncertainty += deltas.uncertaintyDelta;
            cumulativeAccountedMass += deltas.massDelta;
            prunedMass += deltas.prunedDelta;
        }

        let frontierUncertainty = 0n;
        for (const item of queue.items) {
            frontierUncertainty += item.prob;
        }

        const out: SearchFrontier = { queue, results, uncertainty, cumulativeAccountedMass, prunedMass, threshold };
        
        activeCache.set(cacheKey, out);
        // Return core results (terminal/pruned) and total uncertainty (pruned + queue)
        return { ...out, results, uncertainty: uncertainty + frontierUncertainty }; 
    }

    private getGuaranteedFirstId(guaranteedFirst: string | null): number | null {
        if (!guaranteedFirst) return null;
        const romanMap = this.registry.data.constants.ROMAN_MAP;
        const base = RomanUtils.getBaseName(guaranteedFirst, romanMap);
        const id = this.registry.getEnchantId(base);
        return id !== ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID ? id : null;
    }

    private initializeSearchFrontier(
        cat: string,
        modLevel: number,
        guaranteedFirst: string | null,
        cached?: SearchFrontier,
        existing?: SearchFrontier,
        threshold: bigint = 0n
    ): SearchFrontier {
        if (existing) {
            return {
                queue: existing.queue.clone(),
                results: new Map(existing.results),
                uncertainty: existing.uncertainty,
                cumulativeAccountedMass: existing.cumulativeAccountedMass,
                prunedMass: existing.prunedMass || 0n,
                threshold: existing.threshold
            };
        }

        if (cached && cached.threshold > threshold) {
            return {
                queue: cached.queue.clone(),
                results: new Map(cached.results),
                uncertainty: cached.uncertainty,
                cumulativeAccountedMass: cached.cumulativeAccountedMass,
                prunedMass: cached.prunedMass || 0n,
                threshold: cached.threshold
            };
        }

        const results = new Map<PackedCombo, bigint>();
        const queue = new BinaryHeap<PackedNode>((item) => item.meta);
        const romanMap = this.registry.data.constants.ROMAN_MAP;
        const guaranteedId = this.getGuaranteedFirstId(guaranteedFirst);
        
        const rankStr = guaranteedFirst?.split(' ').pop();
        const rank = rankStr ? RomanUtils.getRomanValue(rankStr, romanMap) : null;
        const full = (guaranteedId !== null && rank !== null) ? (guaranteedId << 8 | rank) : null;

        const initialPacked = full !== null ? ComboUtils.pack([full], guaranteedId) : 0n;
        const initialBitset = guaranteedId !== null ? (1n << BigInt(guaranteedId)) : 0n;

        queue.push({
            packedChosen: initialPacked,
            meta: (initialBitset << 8n) | BigInt(modLevel),
            prob: PRECISION
        });

        return { queue, results, uncertainty: 0n, cumulativeAccountedMass: 0n, prunedMass: 0n, threshold };
    }

    private processSearchNode(
        current: PackedNode,
        cat: string,
        guaranteedFirstId: number | null,
        pool: PackedEnchant[],
        poolWeights: number[],
        threshold: bigint,
        results: Map<PackedCombo, bigint>,
        queue: BinaryHeap<PackedNode>
    ): { uncertaintyDelta: bigint; massDelta: bigint; prunedDelta: bigint } {
        const currentBitset = current.meta >> 8n;
        const currentLevel = Number(current.meta & 0xFFn);
        const currentCount = ComboUtils.getCount(current.packedChosen);

        const probContinueNum = (cat === "book" && !this.registry.multiEnchantBooks) ? 0 : Math.min((currentLevel + 1) / ENGINE_DEFAULTS.MAX_MODIFIED_LEVEL_FOR_CONTINUING, 1.0);
        const probContinue = ProbUtils.toBigInt(probContinueNum);

        if (probContinue <= 0n) {
            results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + current.prob);
            return { uncertaintyDelta: 0n, massDelta: current.prob, prunedDelta: 0n };
        }

        const probStop = ProbUtils.scale(current.prob, (PRECISION - probContinue));
        results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probStop);
        
        const probForward = ProbUtils.scale(current.prob, probContinue);

        // Safety checks
        const isLimitReached = currentCount >= ENGINE_DEFAULTS.MAX_ENCHANTS_PER_ITEM;
        const isTooSmall = probForward < threshold / ENGINE_DEFAULTS.PRUNE_THRESHOLD_DENOMINATOR;
        const isMapFull = results.size >= ENGINE_DEFAULTS.MAX_RESULTS_SIZE && !results.has(current.packedChosen);

        if (isLimitReached || isTooSmall || isMapFull) {
            results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probForward);
            return { uncertaintyDelta: probForward, massDelta: probStop + probForward, prunedDelta: probForward };
        }

        // Branching
        let totalWeight = 0;
        const eligible: PackedEnchant[] = [];
        const weights: number[] = [];

        for (let i = 0; i < pool.length; i++) {
            const e = pool[i];
            const id = ComboUtils.getEnchantId(e);
            if ((currentBitset & (1n << BigInt(id))) !== 0n) continue;
            if ((currentBitset & this.registry.conflictBitsets[id]) !== 0n) continue;
            eligible.push(e);
            weights.push(poolWeights[i]);
            totalWeight += poolWeights[i];
        }

        if (totalWeight === 0) {
            results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probForward);
            return { uncertaintyDelta: 0n, massDelta: probStop + probForward, prunedDelta: 0n };
        }

        const nextLevel = currentCount >= 1 ? Math.floor(currentLevel / 2) : currentLevel;
        const pBase = probForward / BigInt(totalWeight);
        const currentChosen = ComboUtils.unpack(current.packedChosen);

        for (let i = 0; i < eligible.length; i++) {
            if (queue.size() >= ENGINE_DEFAULTS.MAX_QUEUE_SIZE) {
                results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probForward);
                return { uncertaintyDelta: probForward, massDelta: probStop + probForward, prunedDelta: probForward };
            }
            queue.push({
                packedChosen: ComboUtils.pack([...currentChosen, eligible[i]], guaranteedFirstId),
                meta: ((currentBitset | BitwiseUtils.getBitset(ComboUtils.getEnchantId(eligible[i]))) << 8n) | BigInt(nextLevel),
                prob: BigInt(weights[i]) * pBase
            });
        }

        return { uncertaintyDelta: 0n, massDelta: probStop, prunedDelta: 0n };
    }

    private processInitialNode(
        current: PackedNode,
        modLevel: number,
        guaranteedId: number | null,
        pool: PackedEnchant[],
        weights: number[],
        totalWeight: number,
        queue: BinaryHeap<PackedNode>
    ): void {
        const pBase = current.prob / BigInt(totalWeight);
        for (let i = 0; i < pool.length; i++) {
            queue.push({
                packedChosen: ComboUtils.pack([pool[i]], guaranteedId),
                meta: (BitwiseUtils.getBitset(ComboUtils.getEnchantId(pool[i])) << 8n) | BigInt(modLevel),
                prob: BigInt(weights[i]) * pBase
            });
        }
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
        const totalAnyMass = new Map<number, bigint>();
        const totalRankMass = new Map<number, bigint>();
        const totalCountMass = new Map<number, bigint>();

        const activeThreshold = guaranteedFirst ? bThreshold / 10n : bThreshold;

        let processedMProb = 0n;
        let totalUncertainty = 0n;
        let totalPrunedMass = 0n;
        
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

            // Accumulate masses from this Modified Level's frontier
            const mlStats = this.summarizeFrontier(result);
            for (const [id, mass] of mlStats.anyMass) {
                totalAnyMass.set(id, (totalAnyMass.get(id) || 0n) + ProbUtils.scale(mass, mProb));
            }
            for (const [id, mass] of mlStats.rankMass) {
                totalRankMass.set(id, (totalRankMass.get(id) || 0n) + ProbUtils.scale(mass, mProb));
            }
            for (const [c, mass] of mlStats.countMass) {
                totalCountMass.set(c, (totalCountMass.get(c) || 0n) + ProbUtils.scale(mass, mProb));
            }

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

        const finalStats = ResultProcessor.summarize(finalCombos, totalUncertainty, totalAnyMass, totalRankMass, totalCountMass, 100);
        finalStats.pruned = ProbUtils.toNumber(totalPrunedMass);
        this.statsCache.set(exactKey, finalStats);
        
        const best = this.bestStatsCache.get(baseKey);
        if (!best || threshold < best.threshold) {
            this.bestStatsCache.set(baseKey, { threshold, stats: finalStats });
        }

        return finalStats;
    }

    private summarizeFrontier(f: SearchFrontier): { anyMass: Map<number, bigint>, rankMass: Map<number, bigint>, countMass: Map<number, bigint> } {
        const anyMass = new Map<number, bigint>();
        const rankMass = new Map<number, bigint>();
        const countMass = new Map<number, bigint>();

        // Results contain finalized or pruned terminal nodes
        for (const [packed, prob] of f.results) {
            const enchants = ComboUtils.unpack(packed);
            countMass.set(enchants.length, (countMass.get(enchants.length) || 0n) + prob);
            for (const e of enchants) {
                const anyId = e >> 8;
                anyMass.set(anyId, (anyMass.get(anyId) || 0n) + prob);
                rankMass.set(e, (rankMass.get(e) || 0n) + prob);
            }
        }

        // Queue contains nodes still in search frontier
        // For ANY and RANK, we count these paths because we KNOW these enchants are present.
        // For COUNT, we DON'T count these yet (they stay in uncertainty) to keep charts stacked correctly.
        for (const item of f.queue.items) {
            const enchants = ComboUtils.unpack(item.packedChosen);
            for (const e of enchants) {
                const anyId = e >> 8;
                anyMass.set(anyId, (anyMass.get(anyId) || 0n) + item.prob);
                rankMass.set(e, (rankMass.get(e) || 0n) + item.prob);
            }
        }

        return { anyMass, rankMass, countMass };
    }
}
