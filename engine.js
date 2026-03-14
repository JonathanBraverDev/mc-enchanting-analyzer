/**
 * Utility functions for version parsing and comparison.
 */
const VersionUtils = {
    /**
     * Parses a version string into an array of numbers.
     * @param {string} v - Version string (e.g., "1.8.9").
     * @returns {number[]} Array of numbers.
     */
    parse: (v) => (v.match(/\d+/g) || []).map(Number),

    /**
     * Compares two version strings.
     * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
     */
    compare: (v1, v2) => {
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
    isInRange: (target, start, end = "99.9") => {
        return VersionUtils.compare(target, start) >= 0 && VersionUtils.compare(target, end) <= 0;
    }
};

/**
 * Core math and logic engine for Minecraft Enchanting.
 */
class EnchantEngine {
    static distCache = new Map();
    
    constructor(data, version) {
        this.data = data;
        this.version = version;
        this.comboCache = new Map();
        
        // Context-specific caches
        this.mechanics = {};
        this.mergedItems = {};
        this.mergedOverrides = {};
        this.mergedMaterials = new Set();
        this.multiEnchantBooks = true;

        this.setupContext();
    }

    /**
     * Converts a numeric rank to a Roman numeral.
     */
    rankToRoman(rank) {
        return Object.keys(this.data.constants.ROMAN_MAP)[rank - 1] || rank;
    }

    /**
     * Extracts Roman numeral value from a string.
     */
    getRomanValue(r) {
        return this.data.constants.ROMAN_MAP[r] || 0;
    }

    /**
     * Gets the base name of an enchantment (removes level).
     */
    getBaseName(fullName) {
        const parts = fullName.split(" ");
        const last = parts[parts.length - 1];
        return Object.keys(this.data.constants.ROMAN_MAP).includes(last) ? parts.slice(0, -1).join(" ") : fullName;
    }

    /**
     * Builds the version-specific context by merging manifests according to inheritance.
     */
    setupContext() {
        const { versions, enchantment_groups } = this.data;
        let curr = this.version;

        // Ensure we handle sub-versions correctly
        if (!versions[curr]) {
            const sorted = Object.keys(versions).sort(VersionUtils.compare);
            for (const v of sorted) {
                if (VersionUtils.compare(this.version, v) >= 0) curr = v;
            }
        }

        const chain = [];
        let temp = curr;
        while (temp) {
            chain.unshift(temp);
            temp = versions[temp]?.extends;
        }

        // Apply inheritance chain
        for (const vName of chain) {
            const manifest = versions[vName];
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
    }

    /**
     * Gets base enchantability for an item/material pair.
     */
    getEnchantability(mat, cat) {
        if (cat === "book") return 1;
        const { armor, tools } = this.data.material_values;
        const isArmor = this.data.constants.ARMOR_CATS.includes(cat);
        return (isArmor ? armor[mat] : tools[mat]) || 10;
    }

    /**
     * Calculates the probability distribution of Modified Levels.
     * This is the "heart" of the stochastic simulation.
     */
    getModifiedLevelDist(xp, enchantability) {
        const key = `${xp}@${enchantability}@${this.mechanics.enchantability_bonus_divisor}@${this.mechanics.random_bonus_range}`;
        if (EnchantEngine.distCache.has(key)) return EnchantEngine.distCache.get(key);

        if (enchantability <= 0) return { [xp]: 1.0 };
        
        const div = this.mechanics.enchantability_bonus_divisor || 4;
        const rngRange = this.mechanics.random_bonus_range || 0.15;
        const N = Math.floor(enchantability / div) + 1;
        
        // Phase 1: Base Enchantment Level randomness
        const baseDist = {};
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < N; j++) {
                const val = xp + i + j + 1;
                baseDist[val] = (baseDist[val] || 0) + 1 / (N * N);
            }
        }

        // Phase 2: Random Bonus multiplier
        const finalDist = {};
        const steps = 25; 
        for (let [base, bProb] of Object.entries(baseDist)) {
            base = Number(base);
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
    getEligibleList(cat, level, mat, chosenNames = new Set()) {
        const registry = this.data.global_enchantments;
        const pool = this.mergedItems[cat] || [];
        const out = [];
        
        for (const name of pool) {
            if (chosenNames.has(name)) continue;
            
            const props = Object.assign({}, registry[name], this.mergedOverrides[name] || {});
            if (!VersionUtils.isInRange(this.version, props.valid_from, props.valid_to)) continue;
            
            // Conflict check
            const hasConflict = Array.from(chosenNames).some(chosen => {
                const cProps = Object.assign({}, registry[chosen], this.mergedOverrides[chosen] || {});
                return cProps.conflicts?.includes(name) || props.conflicts?.includes(chosen);
            });
            if (hasConflict) continue;

            // Find best available rank for this level
            const rKeys = Object.keys(this.data.constants.ROMAN_MAP).reverse();
            for (const r of rKeys) {
                const range = props.levels[r];
                if (range && level >= range[0] && level <= range[1]) {
                    out.push({ name, weight: props.weight, rank: r });
                    break;
                }
            }
        }
        return out;
    }

    /**
     * Generates a unique key for a set of enchantments.
     */
    getComboKey(chosen, initialSeed) {
        const sorted = [...chosen].sort((a, b) => {
            if (initialSeed) {
                if (a === initialSeed) return -1;
                if (b === initialSeed) return 1;
            }
            const nameA = this.getBaseName(a), rankA = a.split(' ').pop();
            const nameB = this.getBaseName(b), rankB = b.split(' ').pop();
            const valA = this.getRomanValue(rankA), valB = this.getRomanValue(rankB);
            
            if (valA !== valB) return valB - valA;
            const weightA = (this.data.global_enchantments[nameA] || { weight: 10 }).weight;
            const weightB = (this.data.global_enchantments[nameB] || { weight: 10 }).weight;
            if (weightA !== weightB) return weightA - weightB;
            return nameA.localeCompare(nameB);
        });
        return sorted.join("+");
    }

    /**
     * Recursively calculates all possible enchantment combinations.
     */
    calculateCombinations(cat, modLevel, mat, initialSeed = null, threshold = 0.0001) {
        const solve = (chosen, level, branchProb = 1.0) => {
            if (branchProb < threshold) return {};

            const chosenNames = new Set(chosen.map(e => this.getBaseName(e)));
            const eligible = this.getEligibleList(cat, level, mat, chosenNames);

            // Special handle for older books
            if (cat === "book" && chosen.length >= 1 && !this.multiEnchantBooks) {
                return { [this.getComboKey(chosen, initialSeed)]: 1.0 };
            }

            const currentKey = this.getComboKey(chosen, initialSeed);
            const cacheKey = `${cat}|${currentKey}|${level}|${initialSeed}|${threshold}`;
            if (this.comboCache.has(cacheKey)) return this.comboCache.get(cacheKey);
            
            const totalWeight = eligible.reduce((s, e) => s + e.weight, 0);
            const probContinue = (cat === "book" && !this.multiEnchantBooks) ? 0 : Math.min((level + 1) / 50, 1.0);

            const results = {};
            if (chosen.length === 0) {
                // First enchantment pick
                for (const e of eligible) {
                    const pWeight = e.weight / totalWeight;
                    const sub = solve([`${e.name} ${e.rank}`], level, branchProb * pWeight);
                    for (const [c, p] of Object.entries(sub)) results[c] = (results[c] || 0) + pWeight * p;
                }
            } else {
                results[currentKey] = 1 - probContinue;
                if (probContinue > 0 && eligible.length > 0) {
                    for (const e of eligible) {
                        const pWeight = (e.weight / totalWeight) * probContinue;
                        const nextLevel = chosen.length >= 2 ? Math.floor(level / 2) : level;
                        const sub = solve([...chosen, `${e.name} ${e.rank}`], nextLevel, branchProb * pWeight);
                        for (const [c, p] of Object.entries(sub)) results[c] = (results[c] || 0) + pWeight * p;
                    }
                } else {
                    results[currentKey] = 1.0;
                }
            }
            this.comboCache.set(cacheKey, results);
            return results;
        };

        return solve(initialSeed ? [initialSeed] : [], modLevel, 1.0);
    }

    /**
     * Aggregates all statistics for a given enchantment attempt.
     */
    getFullStats(cat, xp, mat, initialSeed = null, threshold = 0.0001) {
        const enchantability = this.getEnchantability(mat, cat);
        const modDist = this.getModifiedLevelDist(xp, enchantability);
        const finalCombos = {};

        for (const [ml, mProb] of Object.entries(modDist)) {
            if (mProb < threshold) continue; 
            const combos = this.calculateCombinations(cat, Number(ml), mat, initialSeed, threshold);
            for (const [c, p] of Object.entries(combos)) {
                finalCombos[c] = (finalCombos[c] || 0) + p * mProb;
            }
        }

        const stats = { ranks: {}, any: {}, count: {}, combos: finalCombos };
        for (const [combo, p] of Object.entries(finalCombos)) {
            const parts = combo.split("+");
            stats.count[parts.length] = (stats.count[parts.length] || 0) + p;
            
            const seenBases = new Set();
            for (const entry of parts) {
                stats.ranks[entry] = (stats.ranks[entry] || 0) + p;
                const base = this.getBaseName(entry);
                if (!seenBases.has(base)) {
                    stats.any[base] = (stats.any[base] || 0) + p;
                    seenBases.add(base);
                }
            }
        }
        return stats;
    }
}
