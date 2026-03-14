// --- MATH UTILS ---
function parseVersion(v) {
    return (v.match(/\d+/g) || []).map(Number);
}

function isVersionInRange(target, start, end = "99.9") {
    const t = parseVersion(target);
    const s = parseVersion(start);
    const e = parseVersion(end);
    
    const cmp = (a, b) => {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const valA = a[i] || 0;
            const valB = b[i] || 0;
            if (valA > valB) return 1;
            if (valA < valB) return -1;
        }
        return 0;
    };

    return cmp(t, s) >= 0 && cmp(t, e) <= 0;
}

function getRomanValue(r) {
    const map = { "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5 };
    return map[r] || 0;
}

function getBaseName(fullName) {
    const parts = fullName.split(" ");
    const last = parts[parts.length - 1];
    if (["I", "II", "III", "IV", "V"].includes(last)) {
        return parts.slice(0, -1).join(" ");
    }
    return fullName;
}

// --- CALCULATION ENGINE ---
class EnchantEngine {
    static distCache = new Map();
    
    constructor(data, version) {
        this.data = data;
        this.version = version;
        this.comboCache = new Map();
        this.setupContext();
    }

    rankToRoman(rank) {
        return ["I", "II", "III", "IV", "V"][rank - 1] || rank;
    }

    setupContext() {
        const versions = this.data.versions;
        const chain = [];
        let curr = this.version;

        // Robust version finding
        if (!versions[curr]) {
            const sorted = Object.keys(versions).sort((a,b) => {
                const pa = parseVersion(a), pb = parseVersion(b);
                for(let i=0; i<Math.max(pa.length, pb.length); i++){
                    if((pa[i]||0) > (pb[i]||0)) return 1;
                    if((pa[i]||0) < (pb[i]||0)) return -1;
                }
                return 0;
            });
            for(let v of sorted) {
                if(isVersionInRange(this.version, v)) curr = v;
            }
        }

        let temp = curr;
        while(temp) {
            chain.unshift(temp);
            temp = versions[temp]?.extends;
        }

        this.mechanics = {};
        this.mergedItems = {};
        this.mergedOverrides = {};
        this.multiEnchantBooks = true;

        for(let vName of chain) {
            const manifest = versions[vName];
            if(!manifest) continue;

            // Resolve items
            for(let [cat, content] of Object.entries(manifest.item_enchantments || {})) {
                let resolved = [];
                content.forEach(item => {
                    if(this.data.enchantment_groups[item]) resolved.push(...this.data.enchantment_groups[item]);
                    else resolved.push(item);
                });
                this.mergedItems[cat] = [...new Set(resolved)];
            }

            // Mechanics
            Object.assign(this.mechanics, manifest.mechanics || {});
            if(manifest.multi_enchant_books !== undefined) this.multiEnchantBooks = manifest.multi_enchant_books;
            
            // Overrides
            for(let [ench, props] of Object.entries(manifest.overrides || {})) {
                this.mergedOverrides[ench] = Object.assign(this.mergedOverrides[ench] || {}, props);
            }
        }
    }

    getEnchantability(mat, cat) {
        if (cat === "book") return 1;
        const armor = ["helmet", "chestplate", "leggings", "boots", "turtle_shell"];
        const values = this.data.material_values;
        const sub = armor.includes(cat) ? values.armor : values.tools;
        return sub[mat] || 10;
    }

    getModifiedLevelDist(xp, enchantability) {
        const key = `${xp}@${enchantability}@${this.mechanics.enchantability_bonus_divisor}@${this.mechanics.random_bonus_range}`;
        if (EnchantEngine.distCache.has(key)) return EnchantEngine.distCache.get(key);

        if (enchantability <= 0) return { [xp]: 1.0 };
        const div = this.mechanics.enchantability_bonus_divisor || 4;
        const rngRange = this.mechanics.random_bonus_range || 0.15;
        const N = Math.floor(enchantability / div) + 1;
        
        const baseDist = {};
        for(let i=0; i<N; i++) {
            for(let j=0; j<N; j++) {
                const val = xp + i + j + 1;
                baseDist[val] = (baseDist[val] || 0) + 1 / (N*N);
            }
        }

        const finalDist = {};
        const steps = 25; 
        for(let [base, bProb] of Object.entries(baseDist)) {
            base = Number(base);
            for(let i=0; i<steps; i++) {
                for(let j=0; j<steps; j++) {
                    const bonus = (i/(steps-1) * rngRange) + (j/(steps-1) * rngRange) - rngRange;
                    const modVal = Math.max(1, Math.floor(base * (1 + bonus) + 0.5));
                    finalDist[modVal] = (finalDist[modVal] || 0) + (bProb / (steps*steps));
                }
            }
        }
        EnchantEngine.distCache.set(key, finalDist);
        return finalDist;
    }

    getEligibleList(cat, level, mat, chosenNames = new Set()) {
        const registry = this.data.global_enchantments;
        const pool = this.mergedItems[cat] || [];
        const out = [];
        
        for (let i = 0; i < pool.length; i++) {
            const name = pool[i];
            if(chosenNames.has(name)) continue;
            
            const props = Object.assign({}, registry[name], this.mergedOverrides[name] || {});
            if(!isVersionInRange(this.version, props.valid_from, props.valid_to)) continue;
            
            // Conflict check
            let conflict = false;
            for(let chosen of chosenNames) {
                const cProps = Object.assign({}, registry[chosen], this.mergedOverrides[chosen] || {});
                if(cProps.conflicts?.includes(name) || props.conflicts?.includes(chosen)) {
                    conflict = true;
                    break;
                }
            }
            if (conflict) continue;

            let best = null;
            const rKeys = ["V", "IV", "III", "II", "I"];
            for (let j = 0; j < rKeys.length; j++) {
                const r = rKeys[j];
                if(props.levels[r]) {
                    if(level >= props.levels[r][0] && level <= props.levels[r][1]) {
                        best = r;
                        break;
                    }
                }
            }
            if(best) out.push({ name, weight: props.weight, rank: best });
        }
        return out;
    }

    calculateCombinations(cat, modLevel, mat, initialSeed = null, threshold = 0.0001) {
        const solveProper = (chosen, level, branchProb = 1.0) => {
            if (branchProb < threshold) return {};

            const chosenNames = new Set(chosen.map(e => getBaseName(e)));
            const eligible = this.getEligibleList(cat, level, mat, chosenNames);

            if (cat === "book" && chosen.length >= 1 && !this.multiEnchantBooks) {
                return { [chosen.slice().sort().join("+")]: 1.0 };
            }

            const key = `${cat}|${chosen.slice().sort().join("+")}|${level}|${initialSeed}|${threshold}`;
            if(this.comboCache.has(key)) return this.comboCache.get(key);
            
            const totalWeight = eligible.reduce((s, e) => s + e.weight, 0);
            const probContinue = (cat === "book" && !this.multiEnchantBooks) ? 0 : Math.min((level + 1) / 50, 1.0);

            let results = {};
            if(chosen.length === 0) {
                eligible.forEach(e => {
                    const pWeight = e.weight / totalWeight;
                    const sub = solveProper([`${e.name} ${e.rank}`], level, branchProb * pWeight);
                    for(let [c, p] of Object.entries(sub)) results[c] = (results[c]||0) + pWeight * p;
                });
            } else {
                const currentKey = chosen.slice().sort().join("+");
                results[currentKey] = 1 - probContinue;
                if(probContinue > 0 && eligible.length > 0) {
                    eligible.forEach(e => {
                        const pWeight = (e.weight / totalWeight) * probContinue;
                        const sub = solveProper([...chosen, `${e.name} ${e.rank}`], Math.floor(level / 2), branchProb * pWeight);
                        for(let [c, p] of Object.entries(sub)) results[c] = (results[c]||0) + pWeight * p;
                    });
                } else {
                    results[currentKey] = 1.0;
                }
            }
            this.comboCache.set(key, results);
            return results;
        };

        if (initialSeed) {
            return solveProper([initialSeed], modLevel, 1.0);
        }
        return solveProper([], modLevel, 1.0);
    }

    getFullStats(cat, xp, mat, initialSeed = null, threshold = 0.0001) {
        const enchantability = this.getEnchantability(mat, cat);
        const modDist = this.getModifiedLevelDist(xp, enchantability);
        const finalCombos = {};

        for(let [ml, mProb] of Object.entries(modDist)) {
            if (mProb < threshold) continue; 
            const combos = this.calculateCombinations(cat, Number(ml), mat, initialSeed, threshold);
            for(let [c, p] of Object.entries(combos)) {
                finalCombos[c] = (finalCombos[c] || 0) + p * mProb;
            }
        }

        const stats = { ranks: {}, any: {}, count: {}, combos: finalCombos };
        for(let [combo, p] of Object.entries(finalCombos)) {
            const parts = combo.split("+");
            const len = parts.length;
            stats.count[len] = (stats.count[len] || 0) + p;
            
            const seen = new Set();
            parts.forEach(entry => {
                stats.ranks[entry] = (stats.ranks[entry] || 0) + p;
                const base = getBaseName(entry);
                if(!seen.has(base)) {
                    stats.any[base] = (stats.any[base] || 0) + p;
                    seen.add(base);
                }
            });
        }
        return stats;
    }
}
