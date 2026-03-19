import { EnchantmentData, CalculationStats } from './types.js';
import { VersionUtils, BinaryHeap, RomanUtils } from './utils.js';
import { Registry } from './registry.js';

/**
 * Represents the state of a search for enchantment combinations.
 * Can be used to resume calculations at a higher resolution.
 */
export interface SearchFrontier {
    queue: BinaryHeap<{ chosen: number[], bitset: bigint, level: number, prob: number }>;
    results: Map<bigint, number>;
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
    public bestStatsCache = new Map<string, { threshold: number, stats: CalculationStats }>();
    
    private readonly MAX_CACHE_SIZE = 500;

    constructor(data: EnchantmentData, version: string) {
        this.registry = new Registry(data, version);
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
     * Packs a set of enchantments into a bigint.
     * Each enchantment is (id << 4 | rank), 12 bits total.
     */
    public packComboBigInt(chosen: number[], guaranteedFirstId: number | null): bigint {
        if (chosen.length === 0) return 0n;
        
        // Separate guaranteedFirst from others
        let firstPicked: number | null = null;
        const others: number[] = [];
        
        for (const c of chosen) {
            const id = c >> 8;
            const rank = c & 0xFF;
            const val = (id << 4) | (rank & 0x0F);
            if (guaranteedFirstId !== null && id === guaranteedFirstId && firstPicked === null) {
                firstPicked = val;
            } else {
                others.push(val);
            }
        }
        
        others.sort((a, b) => b - a);
        if (firstPicked !== null) others.unshift(firstPicked);
        
        // Pack up to 5 enchantments into a single 64-bit integer.
        // Format: [4 bits: count] [5 slots x 12 bits: (id << 4 | rank)]
        let packed = 0n;
        for (let i = 0; i < others.length; i++) {
            // Shift each 12-bit entry into its designated slot
            packed |= BigInt(others[i]) << BigInt(i * 12);
        }
        // Store the number of enchantments in the highest 4 bits (60-63)
        // This makes keys unique even if one is a prefix of another
        packed |= BigInt(others.length) << 60n;
        
        return packed;
    }

    /**
     * Unpacks a bigint back into numeric enchantment IDs (id << 8 | rank).
     */
    public unpackComboBigInt(packed: bigint): number[] {
        if (packed === 0n) return [];
        // Extract count from top 4 bits
        const count = Number(packed >> 60n);
        // Clear count bits to get the raw enchantment data
        const core = packed & ((1n << 60n) - 1n);
        
        const out: number[] = [];
        for (let i = 0; i < count; i++) {
            // Extract the i-th 12-bit slot
            const val = Number((core >> BigInt(i * 12)) & 0xFFFn);
            // Reconstruct (id << 8 | rank)
            const id = val >> 4;
            const rank = val & 0x0F;
            out.push((id << 8) | rank);
        }
        return out;
    }

    /**
     * Translates a packed combo key to a human-readable string.
     */
    public translateComboKey(key: string | bigint): string {
        if (!key) return "";
        
        if (typeof key === 'string') {
            // Check if it's already translated
            if (key.includes(" ") && !/^[0-9a-fA-F]+$/.test(key)) return key;
            return this.translateComboKey(BigInt("0x" + key));
        }

        const ids = this.unpackComboBigInt(key);
        return ids.map(n => this.registry.getFullEnchantName(n)).join("+");
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
        threshold: number = 0.0001,
        existingFrontier?: SearchFrontier
    ): SearchFrontier {
        const cacheKey = `${cat}|${modLevel}|${mat}|${guaranteedFirst || "none"}`;
        
        // If we have a cached frontier that already met this threshold, return it
        const cached = this.comboCache.get(cacheKey);
        if (cached && cached.threshold <= threshold && !existingFrontier) return cached;

        let results: Map<bigint, number>;
        let uncertainty: number;
        let cumulativeAccountedMass: number;
        let queue: BinaryHeap<{ chosen: number[], bitset: bigint, level: number, prob: number }>;

        const romanMap = this.registry.data.constants.ROMAN_MAP;
        const guaranteedFirstBase = guaranteedFirst ? RomanUtils.getBaseName(guaranteedFirst, romanMap) : null;
        const guaranteedFirstId = guaranteedFirstBase ? this.registry.idMap.get(guaranteedFirstBase)! : null;

        if (existingFrontier) {
            results = new Map(existingFrontier.results);
            uncertainty = existingFrontier.uncertainty;
            cumulativeAccountedMass = existingFrontier.cumulativeAccountedMass;
            queue = existingFrontier.queue.clone();
        } else if (cached && cached.threshold > threshold) {
            // Resume from cache if we're asking for MORE accuracy
            results = new Map(cached.results);
            uncertainty = cached.uncertainty;
            cumulativeAccountedMass = cached.cumulativeAccountedMass;
            queue = cached.queue.clone();
        } else {
            // Start fresh
            results = new Map();
            uncertainty = 0; // Initialize to 0, will track pruned mass
            cumulativeAccountedMass = 0;
            
            const romanMap = this.registry.data.constants.ROMAN_MAP;
            const guaranteedFirstRank = guaranteedFirst ? RomanUtils.getRomanValue(guaranteedFirst.split(' ').pop()!, romanMap) : null;
            const guaranteedFirstFull = guaranteedFirstId !== null && guaranteedFirstRank !== null ? (guaranteedFirstId << 8 | guaranteedFirstRank) : null;

            queue = new BinaryHeap<{ chosen: number[], bitset: bigint, level: number, prob: number }>();
            queue.push({ 
                chosen: guaranteedFirstFull !== null ? [guaranteedFirstFull] : [], 
                bitset: guaranteedFirstId !== null ? (1n << BigInt(guaranteedFirstId)) : 0n,
                level: modLevel, 
                prob: 1.0 
            });
        }

        let iterations = 0;
        const MAX_ITERATIONS = cat === "book" ? 40000 : (threshold < 0.0001 ? 25000 : 10000);

        // Pre-calculate the initial pool for this root modLevel
        const initialPool = this.getEligibleListNumeric(cat, modLevel, mat, 0n);
        const poolWeights = initialPool.map(e => this.registry.weightMap[e >> 8]);
        const initialTotalWeight = poolWeights.reduce((a, b) => a + b, 0);

        if (initialTotalWeight === 0) {
            return { queue: new BinaryHeap(), results: new Map(), uncertainty: 0, cumulativeAccountedMass: 1.0, threshold };
        }

        while (queue.size() > 0 && iterations < MAX_ITERATIONS && cumulativeAccountedMass < 0.9999) {
            const next = queue.peek()!;
            if (next.prob < threshold * 0.1) break;

            iterations++;
            const current = queue.pop()!;
            
            // 1. Initial Selection Slot (Slot 1)
            if (current.chosen.length === 0) {
                const pBase = current.prob / initialTotalWeight;
                for (let i = 0; i < initialPool.length; i++) {
                    const e = initialPool[i];
                    queue.push({ 
                        chosen: [e], 
                        bitset: 1n << BigInt(e >> 8),
                        level: modLevel, // Full level passed for 1st continuation check
                        prob: poolWeights[i] * pBase 
                    });
                }
                continue;
            }

            // 2. Subsequent Selection Processing
            const currentKey = this.packComboBigInt(current.chosen, guaranteedFirstId);
            const probContinue = (cat === "book" && !this.registry.multiEnchantBooks) ? 0 : Math.min((current.level + 1) / 50, 1.0);

            if (probContinue <= 0) {
                results.set(currentKey, (results.get(currentKey) || 0) + current.prob);
                cumulativeAccountedMass += current.prob;
                continue;
            }

            // Stop mass
            const probStop = current.prob * (1 - probContinue);
            results.set(currentKey, (results.get(currentKey) || 0) + probStop);
            cumulativeAccountedMass += probStop;

            // Continue mass
            const probMovingForward = current.prob * probContinue;
            if (probMovingForward < threshold * 0.01) {
                uncertainty += probMovingForward;
                continue;
            }

            // Filter initialPool for conflicts with bitset
            let currentTotalWeight = 0;
            const currentEligible: number[] = [];
            const currentWeights: number[] = [];

            for (let i = 0; i < initialPool.length; i++) {
                const e = initialPool[i];
                const id = e >> 8;
                // Conflict Check (Fast Bitwise)
                if ((current.bitset & (1n << BigInt(id))) !== 0n) continue;
                if ((current.bitset & this.registry.conflictBitsets[id]) !== 0n) continue;

                currentEligible.push(e);
                currentWeights.push(poolWeights[i]);
                currentTotalWeight += poolWeights[i];
            }

            if (currentTotalWeight === 0) {
                // If we can't find anything to add, the probability remains with the current combo
                results.set(currentKey, (results.get(currentKey) || 0) + probMovingForward);
                cumulativeAccountedMass += probMovingForward;
                continue;
            }

            // halving only happens AFTER the first additional pick (second pick total)
            const nextLevel = current.chosen.length >= 1 ? Math.floor(current.level / 2) : current.level;
            
            const pNextBase = probMovingForward / currentTotalWeight;
            for (let i = 0; i < currentEligible.length; i++) {
                const e = currentEligible[i];
                queue.push({
                    chosen: [...current.chosen, e],
                    bitset: current.bitset | (1n << BigInt(e >> 8)),
                    level: nextLevel,
                    prob: currentWeights[i] * pNextBase
                });
            }
        }

        // Calculate uncertainty and final result for this resolution
        let frontierUncertainty = 0;
        const outResults = new Map(results);
        for (const item of queue.items) {
            frontierUncertainty += item.prob;
            const key = item.chosen.length > 0 ? this.packComboBigInt(item.chosen, guaranteedFirstId) : 0n;
            if (key !== 0n) outResults.set(key, (outResults.get(key) || 0) + item.prob);
        }

        const totalUncertainty = uncertainty + frontierUncertainty;
        // The frontier object stored in cache should keep 'uncertainty' as the pruned mass only
        const out = { queue, results, uncertainty, cumulativeAccountedMass, threshold };
        
        if (this.comboCache.size >= this.MAX_CACHE_SIZE) {
            const firstKey = this.comboCache.keys().next().value;
            if (firstKey !== undefined) this.comboCache.delete(firstKey);
        }
        this.comboCache.set(cacheKey, out);

        // Return the merged result set for the UI, with total uncertainty
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
        useBestCache: boolean = false
    ): Promise<CalculationStats> {
        const baseKey = `${cat}|${xp}|${mat}|${guaranteedFirst || 'none'}`;
        const exactKey = `${baseKey}|${threshold}`;

        // 1. Check exact match cache first
        if (this.statsCache.has(exactKey)) return this.statsCache.get(exactKey)!;

        // 2. If allowed, check for better precision in bestStatsCache
        if (useBestCache) {
            const best = this.bestStatsCache.get(baseKey);
            if (best && best.threshold <= threshold) {
                return best.stats;
            }
        }

        // Guaranteed First validity check: If guaranteedFirst is provided, verify it is possible at ANY possible modified level
        if (guaranteedFirst) {
            const ench = this.registry.getEnchantability(mat, cat);
            const dist = this.getModifiedLevelDist(xp, ench);
            let possible = false;
            for (const ml of Object.keys(dist)) {
                const numeric = this.getEligibleListNumeric(cat, parseInt(ml), mat, 0n);
                if (numeric.some(n => this.registry.getFullEnchantName(n) === guaranteedFirst)) {
                    possible = true;
                    break;
                }
            }
            if (!possible) {
                return { ranks: {}, any: {}, count: {}, combos: {}, uncertainty: 1.0 }; // Impossible combination
            }
        }

        const enchantability = this.registry.getEnchantability(mat, cat);
        const modDist = this.getModifiedLevelDist(xp, enchantability);
        const finalCombos = new Map<bigint, number>();

        const activeThreshold = guaranteedFirst ? threshold / 10 : threshold;

        let processedMProb = 0;
        let totalUncertainty = 0;
        
        let iterCount = 0;
        for (const [mlStr, mProb] of Object.entries(modDist)) {
            if (signal?.aborted) throw new Error("Aborted");
            if (mProb < activeThreshold) {
                totalUncertainty += mProb;
                continue; 
            }
            
            processedMProb += mProb;
            const res = this.calculateCombinations(cat, Number(mlStr), mat, guaranteedFirst, activeThreshold);
            for (const [c, p] of res.results) {
                finalCombos.set(c, (finalCombos.get(c) || 0) + p * mProb);
            }
            totalUncertainty += res.uncertainty * mProb;

            // Yield and report progress every few levels
            if (++iterCount % 3 === 0) {
                if (onProgress) {
                    onProgress(this.summarizeStats(finalCombos, totalUncertainty));
                }
                // Yield to worker event loop
                await new Promise(r => setTimeout(r, 0));
            }
        }

        const stats = this.summarizeStats(finalCombos, totalUncertainty);

        if (this.statsCache.size >= this.MAX_CACHE_SIZE) {
            const firstKey = this.statsCache.keys().next().value;
            if (firstKey !== undefined) this.statsCache.delete(firstKey);
        }
        this.statsCache.set(exactKey, stats);

        // Update bestStatsCache if this is potentially the most precise yet
        const existingBest = this.bestStatsCache.get(baseKey);
        if (!existingBest || threshold <= existingBest.threshold) {
            this.bestStatsCache.set(baseKey, { threshold, stats });
        }

        return stats;
    }

    /**
     * Helper to collapse raw combo results into a stats object.
     */
    private summarizeStats(combos: Map<bigint, number>, uncertainty: number): CalculationStats {
        const stats: CalculationStats = { ranks: {}, any: {}, count: {}, combos: {}, uncertainty };
        
        for (const [packed, p] of combos) {
            stats.combos[packed.toString(16)] = p;
            
            const comboIds = this.unpackComboBigInt(packed);
            stats.count[comboIds.length] = (stats.count[comboIds.length] || 0) + p;
            
            let seenBasesBitmask = 0n;
            for (const n of comboIds) {
                stats.ranks[n] = (stats.ranks[n] || 0) + p;
                
                const id = n >> 8;
                if (!((seenBasesBitmask >> BigInt(id)) & 1n)) {
                    stats.any[id] = (stats.any[id] || 0) + p;
                    seenBasesBitmask |= (1n << BigInt(id));
                }
            }
        }
        return stats;
    }

}
