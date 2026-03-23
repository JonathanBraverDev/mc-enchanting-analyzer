import { EnchantmentData, VersionMechanics, ResolvedRegistry, MergedItems, MergedOverrides } from './types.js';
import { PackedEnchant, RomanUtils } from '../utils/index.js';
import { ENGINE_DEFAULTS } from './config.js';
import { RegistryState } from './factory.js';
import { MaterialService } from './RegistryMaterials.js';
import { PoolService } from './RegistryPools.js';

/**
 * Handles version-specific data lookup and material eligibility.
 * Now a lightweight view over pre-computed RegistryState, delegating complex logic to services.
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

    public versionPool: Map<string, string[]>;
    
    private state: RegistryState;

    constructor(data: EnchantmentData, state: RegistryState) {
        this.data = data;
        this.state = state;
        
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
        return MaterialService.getEligibleMaterials(this.data, cat, this.mergedMaterials);
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
        return PoolService.getEligiblePool(this.state, cat, level, mat);
    }

    public isEnchantmentAchievable(fullName: string, cat: string, mat: string, levels: number[]): boolean {
        return PoolService.isEnchantmentAchievable(this.state, fullName, cat, mat, levels, this.data.constants.ROMAN_MAP);
    }

    public getEnchantability(mat: string, cat: string): number {
        return MaterialService.getEnchantability(this.data, mat, cat);
    }
}
