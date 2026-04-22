import { EnchantmentData, RegistryState, PackedEnchant } from '../types/index.js';
import { RomanUtils, EnchantUtils } from '../utils/index.js';
import { PACKING_CONSTANTS } from '../constants/engine.js';
import { ENGINE_DEFAULTS } from './config.js';

export function getEligibleMaterials(state: RegistryState, cat: string): string[] {
    const itemSpecific = state.data.constants.ITEM_SPECIFIC_CATS;
    const isArmor = state.data.constants.ARMOR_CATS.includes(cat);
    const mats = isArmor ? state.data.material_values.armor : state.data.material_values.tools;

    if (itemSpecific.includes(cat) && mats[cat] && state.mergedMaterials.has(cat)) {
        return [cat];
    }

    const eligible = Object.keys(mats).filter(m => isMaterialCompatible(m, cat, itemSpecific, state.mergedMaterials));
    return sortMaterials(state.data, eligible);
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
    return ((state.conflictBitsets[idA] ?? 0n) & (1n << BigInt(idB))) !== 0n;
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

export function getEligiblePool(
    state: RegistryState,
    cat: string,
    level: number,
    cache?: { getPool(v: string, k: string): PackedEnchant[] | undefined; setPool(v: string, k: string, val: PackedEnchant[]): void },
    version?: string
): PackedEnchant[] {
    const cacheKey = `${cat}|${level}`;
    const cached = (cache && version) ? cache.getPool(version, cacheKey) : undefined;
    if (cached) return cached;

    const pool = state.versionPool.get(cat);
    if (pool === undefined) throw new Error(`Unknown category "${cat}"`);
    const out: PackedEnchant[] = [];

    for (const name of pool) {
        const props = state.resolvedRegistry[name];
        if (!props) continue;
        const id = state.idMap.get(name)!;

        // sortedRanks is sorted descending (highest rank first), so the first matching
        // rank is the highest one achievable at this level. The break is correct.
        for (const [r, rankVal] of state.sortedRanks) {
            const range = props.levels[r];
            if (range && level >= range[0] && level <= range[1]) {
                out.push(((id << PACKING_CONSTANTS.ENCHANT_SHIFT) | rankVal) as PackedEnchant);
                break;
            }
        }
    }

    if (cache && version) cache.setPool(version, cacheKey, out);
    return out;
}

export function getEligibleListNumeric(
    state: RegistryState,
    cat: string,
    level: number,
    bitset: bigint = 0n,
    cache?: { getPool(v: string, k: string): PackedEnchant[] | undefined; setPool(v: string, k: string, val: PackedEnchant[]): void },
    version?: string
): PackedEnchant[] {
    const pool = getEligiblePool(state, cat, level, cache, version);
    if (bitset === 0n) return pool;

    return pool.filter(packedEnchant => {
        const enchantId = packedEnchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        return (bitset & (1n << BigInt(enchantId))) === 0n;
    });
}

export function isEnchantmentAchievable(
    state: RegistryState,
    fullName: string,
    cat: string,
    levels: number[],
    cache?: { getPool(v: string, k: string): PackedEnchant[] | undefined; setPool(v: string, k: string, val: PackedEnchant[]): void },
    version?: string
): boolean {
    const parsed = EnchantUtils.parse(fullName, state.data.constants.ROMAN_MAP);
    if (!parsed) return false;
    const targetId = state.idMap.get(parsed.name);
    if (targetId === undefined) return false;
    const targetRank = parsed.rank;

    for (const ml of levels) {
        const pool = getEligiblePool(state, cat, ml, cache, version);
        if (pool.some(p => (p >> PACKING_CONSTANTS.ENCHANT_SHIFT) === targetId && (p & PACKING_CONSTANTS.RANK_MASK) === targetRank)) return true;
    }
    return false;
}

export function getEnchantability(state: RegistryState, mat: string, cat: string): number {
    if (cat === 'book') return 1;
    const { armor, tools } = state.data.material_values;
    const isArmor = state.data.constants.ARMOR_CATS.includes(cat);
    const value = isArmor ? armor[mat] : tools[mat];
    if (value === undefined) throw new Error(`Unknown material "${mat}" for category "${cat}"`);
    return value;
}

function isMaterialCompatible(mat: string, cat: string, itemCats: string[], mergedMaterials: Set<string>): boolean {
    if (!mergedMaterials.has(mat)) return false;
    if (mat === 'turtle_shell') return cat === 'helmet';
    if (itemCats.includes(mat)) return mat === cat;
    return true;
}

function sortMaterials(data: EnchantmentData, mats: string[]): string[] {
    const priors = data.constants.MATERIAL_PRIORITY;
    return mats.sort((a, b) => {
        const ai = priors.indexOf(a);
        const bi = priors.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.localeCompare(b);
    });
}
