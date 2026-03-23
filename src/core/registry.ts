import { EnchantmentData, VersionMechanics, ResolvedRegistry, MergedItems, MergedOverrides } from './types.js';
import { LRUCache, PackedEnchant, RomanUtils } from '../utils/index.js';
import { ENGINE_DEFAULTS } from './config.js';
import { RegistryState } from './factory.js';

/**
 * Handles version-specific data lookup and material eligibility.
 * Now a lightweight view over pre-computed RegistryState.
 */
export class Registry {
    public version: string;
    public data: EnchantmentData;
    public mechanics: VersionMechanics;
    public mergedItems: MergedItems;
    public mergedOverrides: MergedOverrides;
    public resolvedRegistry: ResolvedRegistry;
    public mergedMaterials: Set<string>;
    public multiEnchantBooks: boolean;
    
    public idMap: Map<string, number>;
    public revIdMap: string[];
    public catIdMap: Map<string, number>;
    public matIdMap: Map<string, number>;
    public conflictBitsets: BigUint64Array;
    public weightMap: Uint32Array;
    public sortedRanks: [string, number][];

    private versionPool: Map<string, string[]>;
    private poolCache = new LRUCache<string, PackedEnchant[]>(200);

    constructor(data: EnchantmentData, state: RegistryState) {
        this.data = data;
        this.version = state.version;
        this.mechanics = state.mechanics;
        this.mergedItems = state.mergedItems;
        this.mergedOverrides = state.mergedOverrides;
        this.resolvedRegistry = state.resolvedRegistry;
        this.mergedMaterials = state.mergedMaterials;
        this.multiEnchantBooks = state.multiEnchantBooks;
        this.idMap = state.idMap;
        this.revIdMap = state.revIdMap;
        this.catIdMap = state.catIdMap;
        this.matIdMap = state.matIdMap;
        this.conflictBitsets = state.conflictBitsets;
        this.weightMap = state.weightMap;
        this.sortedRanks = state.sortedRanks;
        this.versionPool = state.versionPool;
    }

    public getEligibleMaterials(cat: string): string[] {
        const itemSpecific = this.data.constants.ITEM_SPECIFIC_CATS;
        const isArmor = this.data.constants.ARMOR_CATS.includes(cat);
        const mats = isArmor ? this.data.material_values.armor : this.data.material_values.tools;
        
        if (itemSpecific.includes(cat) && mats[cat] && this.mergedMaterials.has(cat)) {
            return [cat];
        }

        const eligible = Object.keys(mats).filter(m => this.isMaterialCompatible(m, cat, itemSpecific));
        return this.sortMaterials(eligible);
    }

    private isMaterialCompatible(mat: string, cat: string, itemCats: string[]): boolean {
        if (!this.mergedMaterials.has(mat)) return false;
        if (mat === "turtle_shell") return cat === "helmet";
        if (itemCats.includes(mat)) return mat === cat;
        return true;
    }

    private sortMaterials(mats: string[]): string[] {
        const priors = this.data.constants.MATERIAL_PRIORITY;
        return mats.sort((a, b) => {
            const ai = priors.indexOf(a), bi = priors.indexOf(b);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return a.localeCompare(b);
        });
    }

    public getEnchantName(id: number): string {
        return this.revIdMap[id] || "Unknown";
    }

    public getRankRoman(rank: number): string {
        return RomanUtils.rankToRoman(rank, this.data.constants.ROMAN_MAP);
    }

    public getCategoryId(cat: string): number {
        return this.catIdMap.get(cat) ?? ENGINE_DEFAULTS.UNKNOWN_CATEGORY_ID;
    }

    public getMaterialId(mat: string): number {
        return this.matIdMap.get(mat) ?? ENGINE_DEFAULTS.UNKNOWN_MATERIAL_ID;
    }

    public getEnchantId(name: string): number {
        return this.idMap.get(name) ?? ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID;
    }

    public hasConflict(idA: number, idB: number): boolean {
        return (this.conflictBitsets[idA] & (1n << BigInt(idB))) !== 0n;
    }

    public isCategoryAvailable(cat: string): boolean {
        const pool = this.mergedItems[cat];
        return !!(pool && pool.length > 0);
    }

    public getCategoryPool(cat: string): string[] {
        return this.mergedItems[cat] || [];
    }

    public getFullEnchantName(idAndRank: number): string {
        const id = idAndRank >> 8;
        const rank = idAndRank & 0xFF;
        return `${this.getEnchantName(id)} ${this.getRankRoman(rank)}`;
    }

    public getEligiblePool(cat: string, level: number, mat: string): PackedEnchant[] {
        const cacheKey = `${cat}|${level}|${mat}`;
        const cached = this.poolCache.get(cacheKey);
        if (cached) return cached;

        const pool = this.versionPool.get(cat) || [];
        const out: PackedEnchant[] = [];
        
        for (const name of pool) {
            const props = this.resolvedRegistry[name];
            const id = this.idMap.get(name)!;
            
            for (const [r, rankVal] of this.sortedRanks) {
                const range = props.levels[r];
                if (range && level >= range[0] && level <= range[1]) {
                    out.push((id << 8) | rankVal);
                    break;
                }
            }
        }

        this.poolCache.set(cacheKey, out);
        return out;
    }

    public isEnchantmentAchievable(fullName: string, cat: string, mat: string, levels: number[]): boolean {
        for (const ml of levels) {
            const pool = this.getEligiblePool(cat, ml, mat);
            if (pool.some(p => this.getFullEnchantName(p) === fullName)) return true;
        }
        return false;
    }

    public getEnchantability(mat: string, cat: string): number {
        if (cat === "book") return 1;
        const { armor, tools } = this.data.material_values;
        const isArmor = this.data.constants.ARMOR_CATS.includes(cat);
        return (isArmor ? armor[mat] : tools[mat]) || 10;
    }
}
