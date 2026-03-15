import { EnchantmentData, VersionManifest, VersionMechanics, CalculationStats } from './types';

/**
 * Utility functions for version parsing and comparison.
 */
export const VersionUtils = {
    /**
     * Parses a version string into an array of numbers.
     * @param v - Version string (e.g., "1.8.9").
     * @returns Array of numbers.
     */
    parse: (v: string): number[] => (v.match(/\d+/g) || []).map(Number),

    /**
     * Compares two version strings.
     * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
     */
    compare: (v1: string, v2: string): number => {
        const p1 = VersionUtils.parse(v1);
        const p2 = VersionUtils.parse(v2);
        const maxLen = Math.max(p1.length, p2.length);
        for (let i = 0; i < maxLen; i++) {
            const a = p1[i] || 0;
            const b = p2[i] || 0;
            if (a > b) return 1;
            if (a < b) return -1;
        }
        return 0;
    },

    /**
     * Checks if a version is within a specific range.
     */
    isInRange: (target: string, start?: string, end: string = "99.9"): boolean => {
        if (!start) return true;
        return VersionUtils.compare(target, start) >= 0 && VersionUtils.compare(target, end) <= 0;
    }
};

/**
 * Lightweight Binary Heap for priority queue operations.
 * Optimized for objects with a numeric 'prob' property.
 */
class BinaryHeap<T extends { prob: number }> {
    private heap: T[] = [];

    push(item: T) {
        this.heap.push(item);
        this.bubbleUp();
    }

    pop(): T | undefined {
        if (this.size() === 0) return undefined;
        const top = this.heap[0];
        const bottom = this.heap.pop();
        if (this.size() > 0 && bottom !== undefined) {
            this.heap[0] = bottom;
            this.sinkDown();
        }
        return top;
    }

    size(): number {
        return this.heap.length;
    }

    private bubbleUp() {
        let idx = this.heap.length - 1;
        const element = this.heap[idx];
        while (idx > 0) {
            let parentIdx = Math.floor((idx - 1) / 2);
            let parent = this.heap[parentIdx];
            if (element.prob <= parent.prob) break;
            this.heap[parentIdx] = element;
            this.heap[idx] = parent;
            idx = parentIdx;
        }
    }

    private sinkDown() {
        let idx = 0;
        const length = this.heap.length;
        const element = this.heap[0];
        while (true) {
            let leftChildIdx = 2 * idx + 1;
            let rightChildIdx = 2 * idx + 2;
            let leftChild, rightChild;
            let swap = null;

            if (leftChildIdx < length) {
                leftChild = this.heap[leftChildIdx];
                if (leftChild.prob > element.prob) {
                    swap = leftChildIdx;
                }
            }

            if (rightChildIdx < length) {
                rightChild = this.heap[rightChildIdx];
                if (
                    (swap === null && rightChild.prob > element.prob) ||
                    (swap !== null && rightChild.prob > leftChild!.prob)
                ) {
                    swap = rightChildIdx;
                }
            }

            if (swap === null) break;
            this.heap[idx] = this.heap[swap];
            this.heap[swap] = element;
            idx = swap;
        }
    }
}

/**
 * Core math and logic engine for Minecraft Enchanting.
 */
export class EnchantEngine {
    static distCache = new Map<string, { [level: number]: number }>();
    
    public data: EnchantmentData;
    public version: string;
    public comboCache = new Map<string, { [combo: string]: number }>();
    public eligiblePoolCache = new Map<string, number[]>();
    public idMap = new Map<string, number>();
    public revIdMap: string[] = [];
    public conflictBitsets: BigUint64Array = new BigUint64Array(0);
    public weightMap: Uint32Array = new Uint32Array(0);

    // ... existing caches ...
    public mechanics: VersionMechanics = {};
    public mergedItems: { [category: string]: string[] } = {};
    public mergedOverrides: { [enchantment: string]: any } = {};
    public resolvedRegistry: { [enchantment: string]: any } = {};
    public mergedMaterials = new Set<string>();
    public multiEnchantBooks: boolean = true;

    constructor(data: EnchantmentData, version: string) {
        this.data = data;
        this.version = version;
        this.setupContext();
    }

    /**
     * Converts a numeric rank to a Roman numeral.
     */
    public rankToRoman(rank: number): string {
        return Object.keys(this.data.constants.ROMAN_MAP)[rank - 1] || rank.toString();
    }

    /**
     * Extracts Roman numeral value from a string.
     */
    public getRomanValue(r: string): number {
        return this.data.constants.ROMAN_MAP[r] || 0;
    }

    /**
     * Gets the base name of an enchantment (removes level).
     */
    public getBaseName(fullName: string): string {
        const parts = fullName.split(" ");
        const last = parts[parts.length - 1];
        return Object.keys(this.data.constants.ROMAN_MAP).includes(last) ? parts.slice(0, -1).join(" ") : fullName;
    }

    /**
     * Builds the version-specific context by merging manifests according to inheritance.
     */
    private setupContext(): void {
        const { versions, enchantment_groups } = this.data;
        let curr = this.version;

        // Ensure we handle sub-versions correctly
        if (!versions[curr]) {
            const sorted = Object.keys(versions).sort(VersionUtils.compare);
            for (const v of sorted) {
                if (VersionUtils.compare(this.version, v) >= 0) curr = v;
            }
        }

        const chain: string[] = [];
        let temp: string | undefined = curr;
        while (temp) {
            chain.unshift(temp);
            temp = versions[temp]?.extends;
        }

        // Apply inheritance chain
        for (const vName of chain) {
            const manifest = versions[vName] as VersionManifest;
            if (!manifest) continue;

            // Merge items and resolve groups
            if (manifest.item_enchantments) {
                for (const [cat, content] of Object.entries(manifest.item_enchantments)) {
                    const resolved = content.flatMap(item => enchantment_groups[item] || [item]);
                    this.mergedItems[cat] = [...new Set(resolved)];
                }
            }

            // Merge mechanics and flags
            Object.assign(this.mechanics, manifest.mechanics || {});
            if (manifest.multi_enchant_books !== undefined) {
                this.multiEnchantBooks = manifest.multi_enchant_books;
            }
            
            // Merge overrides
            if (manifest.overrides) {
                for (const [ench, props] of Object.entries(manifest.overrides)) {
                    this.mergedOverrides[ench] = Object.assign(this.mergedOverrides[ench] || {}, props);
                }
            }

            // Merge materials
            if (manifest.materials) {
                manifest.materials.forEach(m => this.mergedMaterials.add(m));
            }
        }

        // Finalize Registry (Pre-merge overrides for zero-allocation access during recursion)
        const allEnchNames = Object.keys(this.data.global_enchantments);
        this.revIdMap = allEnchNames;
        allEnchNames.forEach((name, i) => this.idMap.set(name, i));
        
        this.conflictBitsets = new BigUint64Array(allEnchNames.length);
        this.weightMap = new Uint32Array(allEnchNames.length);

        for (let i = 0; i < allEnchNames.length; i++) {
            const name = allEnchNames[i];
            const props = Object.assign({}, this.data.global_enchantments[name], this.mergedOverrides[name] || {});
            this.resolvedRegistry[name] = props;
            this.weightMap[i] = props.weight;
            
            let bitset = 0n;
            if (props.conflicts) {
                for (const cName of props.conflicts) {
                    const cId = this.idMap.get(cName);
                    if (cId !== undefined) bitset |= (1n << BigInt(cId));
                }
            }
            this.conflictBitsets[i] = bitset;
        }
    }

    /**
     * Gets base enchantability for an item/material pair.
     */
    public getEnchantability(mat: string, cat: string): number {
        if (cat === "book") return 1;
        const { armor, tools } = this.data.material_values;
        const isArmor = this.data.constants.ARMOR_CATS.includes(cat);
        return (isArmor ? armor[mat] : tools[mat]) || 10;
    }

    /**
     * Calculates the probability distribution of Modified Levels.
     */
    public getModifiedLevelDist(xp: number, enchantability: number): { [level: number]: number } {
        const key = `${xp}@${enchantability}@${this.mechanics.enchantability_bonus_divisor}@${this.mechanics.random_bonus_range}`;
        if (EnchantEngine.distCache.has(key)) return EnchantEngine.distCache.get(key)!;

        if (enchantability <= 0) return { [xp]: 1.0 };
        
        const div = this.mechanics.enchantability_bonus_divisor || 4;
        const rngRange = this.mechanics.random_bonus_range || 0.15;

        const N = Math.floor(enchantability / div) + 1;
        
        const baseDist: { [val: number]: number } = {};
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < N; j++) {
                const val = xp + i + j + 1;
                baseDist[val] = (baseDist[val] || 0) + 1 / (N * N);
            }
        }

        const finalDist: { [modVal: number]: number } = {};
        const steps = 25; 
        for (let [baseStr, bProb] of Object.entries(baseDist)) {
            const base = Number(baseStr);
            for (let i = 0; i < steps; i++) {
                for (let j = 0; j < steps; j++) {
                    const bonus = (i / (steps - 1) * rngRange) + (j / (steps - 1) * rngRange) - rngRange;
                    const modVal = Math.max(1, Math.floor(base * (1 + bonus) + 0.5));
                    finalDist[modVal] = (finalDist[modVal] || 0) + (bProb / (steps * steps));
                }
            }
        }

        EnchantEngine.distCache.set(key, finalDist);
        return finalDist;
    }

    /**
     * Gets list of enchants eligible for a specific modified level.
     */
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

        const pool = this.mergedItems[cat] || [];
        const out: number[] = [];
        
        const romanMap = this.data.constants.ROMAN_MAP;
        const rEntries = Object.entries(romanMap).sort((a, b) => b[1] - a[1]); // Descending ranks

        for (const name of pool) {
            const id = this.idMap.get(name)!;
            
            // Conflict Check (Fast Bitwise)
            if ((chosenIdsBitset & (1n << BigInt(id))) !== 0n) continue;
            if ((chosenIdsBitset & this.conflictBitsets[id]) !== 0n) continue;

            const props = this.resolvedRegistry[name];
            if (!VersionUtils.isInRange(this.version, props.valid_from, props.valid_to)) continue;
            
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

    // Deprecated string-based version for legacy/UI code if needed
    public getEligibleList(cat: string, level: number, mat: string, chosenNames: Set<string> = new Set()): { name: string, weight: number, rank: string }[] {
        let bitset = 0n;
        for (const name of chosenNames) {
            const id = this.idMap.get(name);
            if (id !== undefined) bitset |= (1n << BigInt(id));
        }
        const numeric = this.getEligibleListNumeric(cat, level, mat, bitset);
        const romanMap = this.data.constants.ROMAN_MAP;
        const revRomanMap = Object.entries(romanMap).reduce((acc, [k, v]) => { acc[v] = k; return acc; }, {} as any);
        
        return numeric.map(n => ({
            name: this.revIdMap[n >> 8],
            weight: this.weightMap[n >> 8],
            rank: revRomanMap[n & 0xFF]
        }));
    }

    /**
     * Generates a unique key for a set of enchantments (numeric version).
     */
    public getComboKeyNumeric(chosen: number[], initialSeedId: number | null): string {
        // chosen is already (id << 8 | rank)
        // We need to sort them consistently, except the seed if present
        const sorted = [...chosen].sort((a, b) => {
            if (initialSeedId !== null) {
                if ((a >> 8) === initialSeedId) return -1;
                if ((b >> 8) === initialSeedId) return 1;
            }
            const idA = a >> 8, idB = b >> 8;
            const rankA = a & 0xFF, rankB = b & 0xFF;
            
            if (rankA !== rankB) return rankB - rankA;
            const weightA = this.weightMap[idA];
            const weightB = this.weightMap[idB];
            if (weightA !== weightB) return weightA - weightB;
            return idA - idB;
        });

        // Convert back to string format for the key (UI expects "Name Rank+Name Rank")
        let key = "";
        const romanMap = this.data.constants.ROMAN_MAP;
        const revRomanMap = Object.entries(romanMap).reduce((acc, [k, v]) => { acc[v] = k; return acc; }, {} as any);
        
        for (let i = 0; i < sorted.length; i++) {
            if (i > 0) key += "+";
            const id = sorted[i] >> 8;
            const rank = sorted[i] & 0xFF;
            key += this.revIdMap[id] + " " + revRomanMap[rank];
        }
        return key;
    }

    /**
     * Recursively calculates all possible enchantment combinations.
     */
    /**
     * Iteratively calculates enchantment combinations using a Best-First approach 
     * to preserve accuracy in high-branching scenarios like Books.
     */
    public calculateCombinations(cat: string, modLevel: number, mat: string, initialSeed: string | null = null, threshold: number = 0.0001): { results: { [combo: string]: number }, uncertainty: number } {
        const results: { [combo: string]: number } = {};
        let uncertainty = 0;
        
        const initialSeedBase = initialSeed ? this.getBaseName(initialSeed) : null;
        const initialSeedId = initialSeedBase ? this.idMap.get(initialSeedBase)! : null;
        const initialSeedRank = initialSeed ? this.getRomanValue(initialSeed.split(' ').pop()!) : null;
        const initialSeedFull = initialSeedId !== null && initialSeedRank !== null ? (initialSeedId << 8 | initialSeedRank) : null;

        const queue = new BinaryHeap<{ chosen: number[], bitset: bigint, level: number, prob: number }>();
        queue.push({ 
            chosen: initialSeedFull !== null ? [initialSeedFull] : [], 
            bitset: initialSeedId !== null ? (1n << BigInt(initialSeedId)) : 0n,
            level: modLevel, 
            prob: 1.0 
        });

        let iterations = 0;
        let cumulativeAccountedMass = 0;
        const MAX_ITERATIONS = initialSeed ? 5000 : 2000;

        while (queue.size() > 0 && iterations < MAX_ITERATIONS) {
            iterations++;
            const current = queue.pop()!;
            const currentKey = current.chosen.length > 0 ? this.getComboKeyNumeric(current.chosen, initialSeedId) : "";

            if (current.prob < threshold || cumulativeAccountedMass > 0.999) {
                if (currentKey) {
                    results[currentKey] = (results[currentKey] || 0) + current.prob;
                    uncertainty += current.prob;
                } else {
                    uncertainty += current.prob;
                }
                continue;
            }

            const eligible = this.getEligibleListNumeric(cat, current.level, mat, current.bitset);

            if (cat === "book" && current.chosen.length >= 1 && !this.multiEnchantBooks) {
                results[currentKey] = (results[currentKey] || 0) + current.prob;
                cumulativeAccountedMass += current.prob;
                continue;
            }

            const probContinue = (cat === "book" && !this.multiEnchantBooks) ? 0 : Math.min((current.level + 1) / 50, 1.0);

            if (current.chosen.length === 0) {
                let totalWeight = 0;
                for (let i = 0; i < eligible.length; i++) totalWeight += this.weightMap[eligible[i] >> 8];
                
                if (totalWeight === 0) {
                    uncertainty += current.prob;
                    continue;
                }
                for (let i = 0; i < eligible.length; i++) {
                    const e = eligible[i];
                    queue.push({ 
                        chosen: [e], 
                        bitset: 1n << BigInt(e >> 8),
                        level: current.level, 
                        prob: current.prob * (this.weightMap[e >> 8] / totalWeight) 
                    });
                }
            } else {
                if (probContinue > 0 && eligible.length > 0) {
                    const probStop = current.prob * (1 - probContinue);
                    results[currentKey] = (results[currentKey] || 0) + probStop;
                    cumulativeAccountedMass += probStop;

                    let totalWeight = 0;
                    for (let i = 0; i < eligible.length; i++) totalWeight += this.weightMap[eligible[i] >> 8];
                    const nextLevel = current.chosen.length >= 2 ? Math.floor(current.level / 2) : current.level;
                    
                    for (let i = 0; i < eligible.length; i++) {
                        const e = eligible[i];
                        queue.push({
                            chosen: [...current.chosen, e],
                            bitset: current.bitset | (1n << BigInt(e >> 8)),
                            level: nextLevel,
                            prob: current.prob * probContinue * (this.weightMap[e >> 8] / totalWeight)
                        });
                    }
                } else {
                    results[currentKey] = (results[currentKey] || 0) + current.prob;
                    cumulativeAccountedMass += current.prob;
                }
            }
        }

        while (queue.size() > 0) {
            const current = queue.pop()!;
            uncertainty += current.prob;
            const key = current.chosen.length > 0 ? this.getComboKeyNumeric(current.chosen, initialSeedId) : "";
            if (key) results[key] = (results[key] || 0) + current.prob;
        }

        return { results, uncertainty };
    }




    /**
     * Aggregates all statistics for a given enchantment attempt.
     */
    public getFullStats(cat: string, xp: number, mat: string, initialSeed: string | null = null, threshold: number = 0.0001): CalculationStats {
        const enchantability = this.getEnchantability(mat, cat);
        const modDist = this.getModifiedLevelDist(xp, enchantability);
        const finalCombos: { [combo: string]: number } = {};

        const activeThreshold = initialSeed ? threshold / 10 : threshold;

        let processedMProb = 0;
        let totalUncertainty = 0;
        
        for (const [mlStr, mProb] of Object.entries(modDist)) {
            if (mProb < activeThreshold) continue; 
            processedMProb += mProb;
            const { results, uncertainty } = this.calculateCombinations(cat, Number(mlStr), mat, initialSeed, activeThreshold);
            for (const [c, p] of Object.entries(results)) {
                finalCombos[c] = (finalCombos[c] || 0) + p * mProb;
            }
            totalUncertainty += uncertainty * mProb;
        }

        const stats: CalculationStats = { ranks: {}, any: {}, count: {}, combos: {}, residual: totalUncertainty };
        
        // Normalization DISABLED for auditing purposes
        const normFactor = 1.0; 

        for (const [combo, rawP] of Object.entries(finalCombos)) {
            const p = rawP * normFactor;
            stats.combos[combo] = p;
            const parts = combo.split("+");
            stats.count[parts.length] = (stats.count[parts.length] || 0) + p;
            
            const seenBases = new Set<string>();
            for (const entry of parts) {
                stats.ranks[entry] = (stats.ranks[entry] || 0) + p;
                const base = this.getBaseName(entry);
                if (!seenBases.has(base)) {
                    stats.any[base] = (stats.any[base] || 0) + p;
                    seenBases.add(base);
                }
            }
        }

        stats.residual = totalUncertainty * normFactor;

        return stats;
    }

}
