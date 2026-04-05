import { RegistryState, PackedEnchant } from '../types/index.js';
import { RomanUtils, LRUCache } from '../utils/index.js';
import { ENGINE_DEFAULTS } from './config.js';
import { MaterialService } from './RegistryMaterials.js';
import { PoolService } from './RegistryPools.js';

export function getEligibleMaterials(state: RegistryState, cat: string): string[] {
    return MaterialService.getEligibleMaterials(state.data, cat, state.mergedMaterials);
}

export function getEnchantName(state: RegistryState, id: number): string {
    const name = state.revIdMap[id];
    if (name === undefined) throw new Error(`Unknown enchant ID ${id}`);
    return name;
}

export function getRankRoman(state: RegistryState, rank: number): string {
    return RomanUtils.rankToRoman(rank, state.data.constants.ROMAN_MAP);
}

export function getCategoryId(state: RegistryState, cat: string): number {
    return state.catIdMap.get(cat) ?? ENGINE_DEFAULTS.UNKNOWN_CATEGORY_ID;
}

export function getMaterialId(state: RegistryState, mat: string): number {
    return state.matIdMap.get(mat) ?? ENGINE_DEFAULTS.UNKNOWN_MATERIAL_ID;
}

export function getEnchantId(state: RegistryState, name: string): number {
    return state.idMap.get(name) ?? ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID;
}

export function hasConflict(state: RegistryState, idA: number, idB: number): boolean {
    return (state.conflictBitsets[idA] & (1n << BigInt(idB))) !== 0n;
}

export function isCategoryAvailable(state: RegistryState, cat: string): boolean {
    const pool = state.mergedItems[cat];
    return !!(pool && pool.length > 0);
}

export function getCategoryPool(state: RegistryState, cat: string): string[] {
    return state.mergedItems[cat] || [];
}

export function getFullEnchantName(state: RegistryState, idAndRank: number): string {
    const id = idAndRank >> 8;
    const rank = idAndRank & 0xFF;
    return `${getEnchantName(state, id)} ${getRankRoman(state, rank)}`;
}

export function getEligiblePool(state: RegistryState, cat: string, level: number, cache?: LRUCache<string, PackedEnchant[]>): PackedEnchant[] {
    return PoolService.getEligiblePool(state, cat, level, cache);
}

export function isEnchantmentAchievable(state: RegistryState, fullName: string, cat: string, levels: number[], cache?: LRUCache<string, PackedEnchant[]>): boolean {
    return PoolService.isEnchantmentAchievable(state, fullName, cat, levels, state.data.constants.ROMAN_MAP, cache);
}

export function getEnchantability(state: RegistryState, mat: string, cat: string): number {
    return MaterialService.getEnchantability(state.data, mat, cat);
}
