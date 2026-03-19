import { EnchantmentData, CalculationStats, HumanStats } from './types.js';
import { VersionUtils, BinaryHeap, RomanUtils, PRECISION, ProbUtils, LRUCache, PackedEnchant, PackedCombo, ComboUtils, ResultProcessor } from './utils.js';
import { Registry } from './registry.js';

/**
 * Represents the state of a search for enchantment combinations.
 * Can be used to resume calculations at a higher resolution.
 */
export interface SearchFrontier {
    queue: BinaryHeap<{ chosen: PackedEnchant[], bitset: bigint, level: number, prob: bigint }>;
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
    
    public registry: Registry;
    public comboCache = new LRUCache<string, SearchFrontier>(500);
    public statsCache = new LRUCache<string, CalculationStats>(500);
    public bestStatsCache = new LRUCache<string, { threshold: number, stats: CalculationStats }>(500);
    
    constructor(data: EnchantmentData, version: string) {
        this.registry = new Registry(data, version);
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
        const steps = 100;
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
     * Translates a packed combo key to a human-readable string.
     */
    public translateComboKey(key: string | PackedCombo): string {
        if (!key) return "";
        
        if (typeof key === 'string') {
            if (key.includes(" ") && !/^[0-9a-fA-F]+$/.test(key)) return key;
            return this.translateComboKey(BigInt("0x" + key));
        }

        const ids = ComboUtils.unpack(key);
        return ids.map(n => this.registry.getFullEnchantName(n)).join("+");
    }

    /**
     * Gets a list of enchants eligible for a specific modified level, filtered by a bitset.
     */
    public getEligibleListNumeric(cat: string, level: number, mat: string, bitset: bigint = 0n): number[] {
        return this.registry.getEligiblePool(cat, level, mat).filter(n => {
            const id = n >> 8;
            return (bitset & (1n << BigInt(id))) === 0n && (bitset & this.registry.conflictBitsets[id]) === 0n;
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
        const cacheKey = `${cat}|${modLevel}|${mat}|${guaranteedFirst || "none"}|limit:${maxIterations ?? 'default'}`;
        
        const cached = this.comboCache.get(cacheKey);
        if (cached && cached.threshold <= threshold && !existingFrontier) return cached;

        let results: Map<PackedCombo, bigint>;
        let uncertainty: bigint;
        let cumulativeAccountedMass: bigint;
        let queue: BinaryHeap<{ chosen: PackedEnchant[], bitset: bigint, level: number, prob: bigint }>;

        const romanMap = this.registry.data.constants.ROMAN_MAP;
        const guaranteedFirstBase = guaranteedFirst ? RomanUtils.getBaseName(guaranteedFirst, romanMap) : null;
        const guaranteedFirstId = guaranteedFirstBase ? this.registry.idMap.get(guaranteedFirstBase)! : null;

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

            queue = new BinaryHeap<{ chosen: PackedEnchant[], bitset: bigint, level: number, prob: bigint }>(
                (item) => (item.bitset << 8n) | BigInt(item.level)
            );
            
            queue.push({ 
                chosen: guaranteedFirstFull !== null ? [guaranteedFirstFull] : [], 
                bitset: guaranteedFirstId !== null ? (1n << BigInt(guaranteedFirstId)) : 0n,
                level: modLevel, 
                prob: PRECISION 
            });
        }

        let iterations = 0;
        const limit = maxIterations ?? (cat === "book" ? 40000 : (ProbUtils.toNumber(threshold) < 0.0001 ? 25000 : 10000));

        const initialPool = this.registry.getEligiblePool(cat, modLevel, mat);
        if (initialPool.length === 0) {
            return { queue: new BinaryHeap(), results: new Map(), uncertainty: 0n, cumulativeAccountedMass: PRECISION, threshold };
        }

        const poolWeights = initialPool.map(e => this.registry.weightMap[e >> 8]);
        const initialTotalWeight = poolWeights.reduce((a, b) => a + b, 0);

        while (queue.size() > 0 && iterations < limit && cumulativeAccountedMass < (PRECISION - (PRECISION / 10000n))) {
            const next = queue.peek()!;
            if (next.prob < threshold / 10n) break;

            iterations++;
            const current = queue.pop()!;
            
            if (current.chosen.length === 0) {
                const pBase = current.prob / BigInt(initialTotalWeight);
                for (let i = 0; i < initialPool.length; i++) {
                    const e = initialPool[i];
                    queue.push({ 
                        chosen: [e], 
                        bitset: 1n << BigInt(e >> 8),
                        level: modLevel,
                        prob: BigInt(poolWeights[i]) * pBase 
                    });
                }
                continue;
            }

            const currentKey = ComboUtils.pack(current.chosen, guaranteedFirstId);
            const probContinueNum = (cat === "book" && !this.registry.multiEnchantBooks) ? 0 : Math.min((current.level + 1) / 50, 1.0);
            const probContinue = ProbUtils.toBigInt(probContinueNum);

            if (probContinue <= 0n) {
                results.set(currentKey, (results.get(currentKey) || 0n) + current.prob);
                cumulativeAccountedMass += current.prob;
                continue;
            }

            const probStop = (current.prob * (PRECISION - probContinue)) / PRECISION;
            results.set(currentKey, (results.get(currentKey) || 0n) + probStop);
            cumulativeAccountedMass += probStop;

            const probMovingForward = (current.prob * probContinue) / PRECISION;
            if (probMovingForward < threshold / 100n) {
                uncertainty += probMovingForward;
                continue;
            }

            let currentTotalWeight = 0;
            const currentEligible: PackedEnchant[] = [];
            const currentWeights: number[] = [];

            for (let i = 0; i < initialPool.length; i++) {
                const e = initialPool[i];
                const id = e >> 8;
                if ((current.bitset & (1n << BigInt(id))) !== 0n) continue;
                if ((current.bitset & this.registry.conflictBitsets[id]) !== 0n) continue;

                currentEligible.push(e);
                currentWeights.push(poolWeights[i]);
                currentTotalWeight += poolWeights[i];
            }

            if (currentTotalWeight === 0) {
                results.set(currentKey, (results.get(currentKey) || 0n) + probMovingForward);
                cumulativeAccountedMass += probMovingForward;
                continue;
            }

            const nextLevel = current.chosen.length >= 1 ? Math.floor(current.level / 2) : current.level;
            const pNextBase = probMovingForward / BigInt(currentTotalWeight);
            for (let i = 0; i < currentEligible.length; i++) {
                const e = currentEligible[i];
                queue.push({
                    chosen: [...current.chosen, e],
                    bitset: current.bitset | (1n << BigInt(e >> 8)),
                    level: nextLevel,
                    prob: BigInt(currentWeights[i]) * pNextBase
                });
            }
        }

        let frontierUncertainty = 0n;
        const outResults = new Map(results);
        for (const item of queue.items) {
            frontierUncertainty += item.prob;
            const key = item.chosen.length > 0 ? ComboUtils.pack(item.chosen, guaranteedFirstId) : 0n;
            if (key !== 0n) outResults.set(key, (outResults.get(key) || 0n) + item.prob);
        }

        const totalUncertainty = uncertainty + frontierUncertainty;
        const out = { queue, results, uncertainty, cumulativeAccountedMass, threshold };
        
        this.comboCache.set(cacheKey, out);
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
        const baseKey = `${cat}|${xp}|${mat}|${guaranteedFirst || 'none'}|limit:${maxIterations ?? 'default'}`;
        const exactKey = `${baseKey}|${threshold}`;

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
                const totalProb = (prob * mProb) / PRECISION;
                finalCombos.set(key, (finalCombos.get(key) || 0n) + totalProb);
            }
            totalUncertainty += (result.uncertainty * mProb) / PRECISION;

            processedMProb += mProb;
            if (++iterCount % 3 === 0) {
                if (onProgress) {
                    onProgress(ResultProcessor.summarize(finalCombos, totalUncertainty + (PRECISION - processedMProb)));
                }
                await new Promise(r => setTimeout(r, 0));
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
