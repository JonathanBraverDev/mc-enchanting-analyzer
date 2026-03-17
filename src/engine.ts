import { EnchantmentData, CalculationStats } from './types.js';
import { VersionUtils, BinaryHeap, RomanUtils } from './utils.js';
import { Registry } from './registry.js';

/**
 * Represents the state of a search for enchantment combinations.
 * Can be used to resume calculations at a higher resolution.
 */
export interface SearchFrontier {
    queue: BinaryHeap<{ chosen: number[], bitset: bigint, level: number, prob: number }>;
    results: { [ids: string]: number };
    uncertainty: number;
    cumulativeAccountedMass: number;
    threshold: number;
}

/**
 * Core math and logic engine for Minecraft Enchanting.
 */
export class EnchantEngine {
    static distCache = new Map<string, { [level: number]: number }>();
    
    public registry: Registry;
    public comboCache = new Map<string, SearchFrontier>();
    public eligiblePoolCache = new Map<string, number[]>();
    public statsCache = new Map<string, CalculationStats>();
    
    private readonly MAX_CACHE_SIZE = 500;
    public revRomanMap: { [val: number]: string } = {};

    constructor(data: EnchantmentData, version: string) {
        this.registry = new Registry(data, version);
        const romanMap = this.registry.data.constants.ROMAN_MAP;
        this.revRomanMap = Object.entries(romanMap).reduce((acc, [k, v]) => { acc[v] = k; return acc; }, {} as any);
    }

    /**
     * Calculates the probability distribution of Modified Levels.
     */
    public getModifiedLevelDist(xp: number, enchantability: number): { [level: number]: number } {
        const mech = this.registry.mechanics;
        const key = `${xp}@${enchantability}@${mech.enchantability_bonus_divisor}@${mech.random_bonus_range}`;
        if (EnchantEngine.distCache.has(key)) return EnchantEngine.distCache.get(key)!;

        if (enchantability <= 0) return { [xp]: 1.0 };
        
        const div = mech.enchantability_bonus_divisor || 4;
        const rngRange = mech.random_bonus_range || 0.15;

        const N = Math.floor(enchantability / div) + 1;
        
        const baseDist: { [val: number]: number } = {};
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < N; j++) {
                const val = xp + i + j + 1;
                baseDist[val] = (baseDist[val] || 0) + 1 / (N * N);
            }
        }

        const finalDist: { [modVal: number]: number } = {};
        const steps = 100; // Increased resolution
        const stepSize = rngRange / (steps - 1);
        
        for (let [baseStr, bProb] of Object.entries(baseDist)) {
            const base = Number(baseStr);
            for (let i = 0; i < steps; i++) {
                const bonusI = i * stepSize;
                for (let j = 0; j < steps; j++) {
                    const bonus = bonusI + (j * stepSize) - rngRange;
                    const modVal = Math.max(1, Math.floor(base * (1 + bonus) + 0.5));
                    finalDist[modVal] = (finalDist[modVal] || 0) + (bProb / (steps * steps));
                }
            }
        }

        EnchantEngine.distCache.set(key, finalDist);
        return finalDist;
    }

    /**
     * Gets list of enchants eligible for a specific modified level (numeric format).
     * Returns array of (id << 8 | rankValue).
     */
    public getEligibleListNumeric(cat: string, level: number, mat: string, chosenIdsBitset: bigint): number[] {
        const cacheKey = `${cat}|${level}|${mat}`;
        const hasChosen = chosenIdsBitset !== 0n;
        
        if (!hasChosen && this.eligiblePoolCache.has(cacheKey)) {
            return this.eligiblePoolCache.get(cacheKey)!;
        }

        const pool = this.registry.mergedItems[cat] || [];
        const out: number[] = [];
        
        const rEntries = this.registry.sortedRanks;

        for (const name of pool) {
            const id = this.registry.idMap.get(name)!;
            
            // Conflict Check (Fast Bitwise)
            if ((chosenIdsBitset & (1n << BigInt(id))) !== 0n) continue;
            if ((chosenIdsBitset & this.registry.conflictBitsets[id]) !== 0n) continue;

            const props = this.registry.resolvedRegistry[name];
            if (!VersionUtils.isInRange(this.registry.version, props.valid_from, props.valid_to)) continue;
            
            for (const [r, rankVal] of rEntries) {
                const range = props.levels[r];
                if (range && level >= range[0] && level <= range[1]) {
                    out.push((id << 8) | rankVal);
                    break;
                }
            }
        }

        if (!hasChosen) {
            this.eligiblePoolCache.set(cacheKey, out);
        }
        return out;
    }


    /**
     * Generates a unique key for a set of enchantments (numeric version).
     */
    public getComboKeyNumeric(chosen: number[], initialSeedId: number | null): string {
        // chosen is already (id << 8 | rank)
        // We need to sort them consistently, except the seed if present
        const sorted = [...chosen].sort((a, b) => {
            const idA = a >> 8, idB = b >> 8;
            if (initialSeedId !== null) {
                if (idA === initialSeedId) return -1;
                if (idB === initialSeedId) return 1;
            }
            if (idA !== idB) return idA - idB;
            return (b & 0xFF) - (a & 0xFF);
        });
        return sorted.join(",");
    }

    /**
     * Translates a numeric combo key to a human-readable string.
     */
    public translateComboKey(key: string): string {
        if (!key) return "";
        
        return key.split(",").map(nStr => {
            const n = parseInt(nStr);
            const id = n >> 8;
            const rank = n & 0xFF;
            return `${this.registry.revIdMap[id]} ${this.revRomanMap[rank]}`;
        }).join("+");
    }

    /**
     * Iteratively calculates enchantment combinations using a Best-First approach.
     * Supports resuming from a previous SearchFrontier if higher accuracy is needed.
     */
    public calculateCombinations(
        cat: string, 
        modLevel: number, 
        mat: string, 
        initialSeed: string | null = null, 
        threshold: number = 0.0001,
        existingFrontier?: SearchFrontier
    ): SearchFrontier {
        const cacheKey = `${cat}|${modLevel}|${mat}|${initialSeed || "none"}`;
        
        // If we have a cached frontier that already met this threshold, return it
        const cached = this.comboCache.get(cacheKey);
        if (cached && cached.threshold <= threshold && !existingFrontier) return cached;

        let results: { [ids: string]: number };
        let uncertainty: number;
        let cumulativeAccountedMass: number;
        let queue: BinaryHeap<{ chosen: number[], bitset: bigint, level: number, prob: number }>;

        const initialSeedBase = initialSeed ? RomanUtils.getBaseName(initialSeed, this.registry.data.constants.ROMAN_MAP) : null;
        const initialSeedId = initialSeedBase ? this.registry.idMap.get(initialSeedBase)! : null;

        if (existingFrontier) {
            results = { ...existingFrontier.results };
            uncertainty = existingFrontier.uncertainty;
            cumulativeAccountedMass = existingFrontier.cumulativeAccountedMass;
            queue = existingFrontier.queue.clone();
        } else if (cached && cached.threshold > threshold) {
            // Resume from cache if we're asking for MORE accuracy
            results = { ...cached.results };
            uncertainty = cached.uncertainty;
            cumulativeAccountedMass = cached.cumulativeAccountedMass;
            queue = cached.queue.clone();
        } else {
            // Start fresh
            results = {};
            uncertainty = 1.0;
            cumulativeAccountedMass = 0;
            
            const romanMap = this.registry.data.constants.ROMAN_MAP;
            const initialSeedRank = initialSeed ? RomanUtils.getRomanValue(initialSeed.split(' ').pop()!, romanMap) : null;
            const initialSeedFull = initialSeedId !== null && initialSeedRank !== null ? (initialSeedId << 8 | initialSeedRank) : null;

            queue = new BinaryHeap<{ chosen: number[], bitset: bigint, level: number, prob: number }>();
            queue.push({ 
                chosen: initialSeedFull !== null ? [initialSeedFull] : [], 
                bitset: initialSeedId !== null ? (1n << BigInt(initialSeedId)) : 0n,
                level: modLevel, 
                prob: 1.0 
            });
        }

        let iterations = 0;
        const MAX_ITERATIONS = initialSeed ? 8000 : 5000;

        while (queue.size() > 0 && iterations < MAX_ITERATIONS && cumulativeAccountedMass < 0.9999) {
            const next = queue.peek()!;
            if (next.prob < threshold) break;

            iterations++;
            const current = queue.pop()!;
            
            const eligible = this.getEligibleListNumeric(cat, current.level, mat, current.bitset);
            const currentKey = current.chosen.length > 0 ? this.getComboKeyNumeric(current.chosen, initialSeedId) : "";

            if (cat === "book" && current.chosen.length >= 1 && !this.registry.multiEnchantBooks) {
                results[currentKey] = (results[currentKey] || 0) + current.prob;
                cumulativeAccountedMass += current.prob;
                continue;
            }

            const probContinue = (cat === "book" && !this.registry.multiEnchantBooks) ? 0 : Math.min((current.level + 1) / 50, 1.0);

            if (current.chosen.length === 0) {
                let totalWeight = 0;
                for (let i = 0; i < eligible.length; i++) totalWeight += this.registry.weightMap[eligible[i] >> 8];
                
                if (totalWeight === 0) {
                    // This probability mass is lost (no enchants possible at this ML)
                    cumulativeAccountedMass += current.prob;
                    continue;
                }
                for (let i = 0; i < eligible.length; i++) {
                    const e = eligible[i];
                    queue.push({ 
                        chosen: [e], 
                        bitset: 1n << BigInt(e >> 8),
                        level: current.level, 
                        prob: current.prob * (this.registry.weightMap[e >> 8] / totalWeight) 
                    });
                }
            } else {
                if (probContinue > 0 && eligible.length > 0) {
                    const probStop = current.prob * (1 - probContinue);
                    results[currentKey] = (results[currentKey] || 0) + probStop;
                    cumulativeAccountedMass += probStop;

                    let totalWeight = 0;
                    for (let i = 0; i < eligible.length; i++) totalWeight += this.registry.weightMap[eligible[i] >> 8];
                    const nextLevel = current.chosen.length >= 2 ? Math.floor(current.level / 2) : current.level;
                    
                    for (let i = 0; i < eligible.length; i++) {
                        const e = eligible[i];
                        queue.push({
                            chosen: [...current.chosen, e],
                            bitset: current.bitset | (1n << BigInt(e >> 8)),
                            level: nextLevel,
                            prob: current.prob * probContinue * (this.registry.weightMap[e >> 8] / totalWeight)
                        });
                    }
                } else {
                    results[currentKey] = (results[currentKey] || 0) + current.prob;
                    cumulativeAccountedMass += current.prob;
                }
            }
        }

        // Calculate uncertainty and final result for this resolution
        let finalUncertainty = 0;
        const outResults = { ...results };
        for (const item of queue.items) {
            finalUncertainty += item.prob;
            const key = item.chosen.length > 0 ? this.getComboKeyNumeric(item.chosen, initialSeedId) : "";
            if (key) outResults[key] = (outResults[key] || 0) + item.prob;
        }

        const out = { queue, results, uncertainty: finalUncertainty, cumulativeAccountedMass, threshold };
        // We override uncertainty in the frontier to the real one, but return collapsed results for getFullStats
        const frontier = { ...out, results: outResults }; 
        
        if (this.comboCache.size >= this.MAX_CACHE_SIZE) {
            const firstKey = this.comboCache.keys().next().value;
            if (firstKey !== undefined) this.comboCache.delete(firstKey);
        }
        this.comboCache.set(cacheKey, out);

        return frontier;
    }


    /**
     * Aggregates all statistics for a given enchantment attempt.
     */
    public async getFullStats(cat: string, xp: number, mat: string, initialSeed: string | null = null, threshold: number = 0.0001): Promise<CalculationStats> {
        const cacheKey = `${cat}|${xp}|${mat}|${initialSeed || 'none'}|${threshold}`;
        if (this.statsCache.has(cacheKey)) return this.statsCache.get(cacheKey)!;

        // Seed validity check: If seed is provided, verify it is possible at ANY possible modified level
        if (initialSeed) {
            const ench = this.registry.getEnchantability(mat, cat);
            const dist = this.getModifiedLevelDist(xp, ench);
            let possible = false;
            for (const ml of Object.keys(dist)) {
                const numeric = this.getEligibleListNumeric(cat, parseInt(ml), mat, 0n);
                if (numeric.some(n => `${this.registry.revIdMap[n >> 8]} ${this.revRomanMap[n & 0xFF]}` === initialSeed)) {
                    possible = true;
                    break;
                }
            }
            if (!possible) {
                return { ranks: {}, any: {}, count: {}, combos: {}, residual: 1.0 }; // Impossible combination
            }
        }

        const enchantability = this.registry.getEnchantability(mat, cat);
        const modDist = this.getModifiedLevelDist(xp, enchantability);
        const finalCombos: { [combo: string]: number } = {};

        const activeThreshold = initialSeed ? threshold / 10 : threshold;

        let processedMProb = 0;
        let totalUncertainty = 0;
        
        let iterCount = 0;
        for (const [mlStr, mProb] of Object.entries(modDist)) {
            if (mProb < activeThreshold) continue; 
            processedMProb += mProb;
            const { results, uncertainty } = this.calculateCombinations(cat, Number(mlStr), mat, initialSeed, activeThreshold);
            for (const [c, p] of Object.entries(results)) {
                finalCombos[c] = (finalCombos[c] || 0) + p * mProb;
            }
            totalUncertainty += uncertainty * mProb;

            // Yield every few levels to keep UI responsive
            if (++iterCount % 5 === 0) await new Promise(r => requestAnimationFrame(r));
        }

        const stats: CalculationStats = { ranks: {}, any: {}, count: {}, combos: {}, residual: totalUncertainty };
        
        // Normalization DISABLED for auditing purposes
        const normFactor = 1.0; 

        for (const [ids, rawP] of Object.entries(finalCombos)) {
            const p = rawP * normFactor;
            stats.combos[ids] = p;
            
            const comboIds = ids.split(",").map(Number);
            stats.count[comboIds.length] = (stats.count[comboIds.length] || 0) + p;
            
            const seenBases = new Set<string>();
            for (const n of comboIds) {
                const id = n >> 8;
                const rank = n & 0xFF;
                const entry = `${this.registry.revIdMap[id]} ${this.revRomanMap[rank]}`;
                stats.ranks[entry] = (stats.ranks[entry] || 0) + p;
                
                const base = this.registry.revIdMap[id];
                if (!seenBases.has(base)) {
                    stats.any[base] = (stats.any[base] || 0) + p;
                    seenBases.add(base);
                }
            }
        }

        stats.residual = totalUncertainty * normFactor;

        if (this.statsCache.size >= this.MAX_CACHE_SIZE) {
            const firstKey = this.statsCache.keys().next().value;
            if (firstKey !== undefined) this.statsCache.delete(firstKey);
        }
        this.statsCache.set(cacheKey, stats);
        return stats;
    }

}
