import { RegistryState, PackedEnchant } from '#types/index.js';
import { RomanUtils, EnchantUtils } from '#utils/index.js';
import { PACKING_CONSTANTS, ENGINE_LIMITS } from '#constants/engine.js';

/**
 * Returns the list of materials compatible with a given enchantable item.
 * Item/material compatibility is declared in registry data.
 * @param state The resolved registry state.
 * @param item The item type (e.g., "sword", "helmet").
 * @returns Sorted list of compatible material names.
 */
export function getEligibleMaterials(state: RegistryState, item: string): string[] {
    const materials = state.itemMaterials[item] ?? [];
    return sortMaterials(state.materialPriority, [...materials]);
}

/**
 * Checks whether a material is valid for an item in the resolved registry version.
 */
export function isMaterialEligible(state: RegistryState, item: string, material: string): boolean {
    return (state.itemMaterials[item] ?? []).includes(material);
}

/**
 * Gets the display name of an enchantment by its ID.
 * @param state The resolved registry state.
 * @param id The enchantment ID.
 * @returns The enchantment name (e.g., "Sharpness", "Protection").
 * @throws If the ID is not found in the registry.
 */
export function getEnchantName(state: RegistryState, id: number): string {
    const name = state.revIdMap[id];
    if (name === undefined) throw new Error(`Unknown enchant ID ${id}`);
    return name;
}

/**
 * Converts a rank number to Roman numeral representation.
 * @param state The resolved registry state.
 * @param rank The rank level (1-based).
 * @returns Roman numeral string (e.g., "I", "II", "III").
 */
export function getRankRoman(state: RegistryState, rank: number): string {
    return RomanUtils.rankToRoman(rank, state.romanMap);
}

/**
 * Gets the internal ID for an enchantable item.
 * @param state The resolved registry state.
 * @param item The item name (e.g., "sword", "helmet").
 * @returns The item ID, or UNKNOWN_ITEM_ID if not found.
 */
export function getItemId(state: RegistryState, item: string): number {
    return state.itemIdMap.get(item) ?? ENGINE_LIMITS.UNKNOWN_ITEM_ID;
}

/**
 * Gets the internal ID for a material.
 * @param state The resolved registry state.
 * @param material The material name (e.g., "diamond", "wood").
 * @returns The material ID, or UNKNOWN_MATERIAL_ID if not found.
 */
export function getMaterialId(state: RegistryState, material: string): number {
    return state.materialIdMap.get(material) ?? ENGINE_LIMITS.UNKNOWN_MATERIAL_ID;
}

/**
 * Gets the internal ID for an enchantment by name.
 * @param state The resolved registry state.
 * @param name The enchantment name (e.g., "sharpness").
 * @returns The enchantment ID, or UNKNOWN_ENCHANT_ID if not found.
 */
export function getEnchantId(state: RegistryState, name: string): number {
    return state.idMap.get(name) ?? ENGINE_LIMITS.UNKNOWN_ENCHANT_ID;
}

/**
 * Checks if two enchantments have a conflict relationship.
 * @param state The resolved registry state.
 * @param idA First enchantment ID.
 * @param idB Second enchantment ID.
 * @returns True if idA and idB conflict.
 */
export function hasConflict(state: RegistryState, idA: number, idB: number): boolean {
    return ((state.conflictBitsets[idA] ?? 0n) & (1n << BigInt(idB))) !== 0n;
}

/**
 * Checks if an item has any enchantable entries.
 * @param state The resolved registry state.
 * @param item The item name.
 * @returns True if the item has at least one enchantment.
 */
export function isItemAvailable(state: RegistryState, item: string): boolean {
    const pool = state.itemPool[item];
    return !!(pool && pool.length > 0);
}

/**
 * Gets the list of enchantment names available for an item.
 * @param state The resolved registry state.
 * @param item The item name.
 * @returns Array of enchantment names, or empty array if item not found.
 */
export function getItemPool(state: RegistryState, item: string): string[] {
    return state.itemPool[item] || [];
}

/**
 * Gets the full display name of an enchantment at a specific rank.
 * @param state The resolved registry state.
 * @param idAndRank Packed (id << 8 | rank) value.
 * @returns Full name including rank (e.g., "Sharpness III").
 */
export function getFullEnchantName(state: RegistryState, idAndRank: number): string {
    const id = idAndRank >> 8;
    const rank = idAndRank & 0xFF;
    return `${getEnchantName(state, id)} ${getRankRoman(state, rank)}`;
}

/**
 * Gets the list of enchantments applicable at a specific modified level.
 * Caches results by version and level key for performance.
 * Each enchantment is returned as a packed (id << 8 | rank) value.
 *
 * @param state The resolved registry state.
 * @param item Item type.
 * @param level The modified level.
 * @param cache Optional cache for pool results (per-version).
 * @param version Optional version key for cache lookup.
 * @returns Array of packed enchantment values available at this level.
 */
export function getEligiblePool(
    state: RegistryState,
    item: string,
    level: number,
    cache?: { getPool(v: string, k: string): PackedEnchant[] | undefined; setPool(v: string, k: string, val: PackedEnchant[]): void },
    version?: string
): PackedEnchant[] {
    const cacheKey = `${item}|${level}`;
    const cached = (cache && version) ? cache.getPool(version, cacheKey) : undefined;
    if (cached) return cached;

    const pool = state.itemPool[item];
    if (pool === undefined) throw new Error(`Unknown item "${item}"`);
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
    item: string,
    level: number,
    bitset: bigint = 0n,
    cache?: { getPool(v: string, k: string): PackedEnchant[] | undefined; setPool(v: string, k: string, val: PackedEnchant[]): void },
    version?: string
): PackedEnchant[] {
    const pool = getEligiblePool(state, item, level, cache, version);
    if (bitset === 0n) return pool;

    return pool.filter(packedEnchant => {
        const enchantId = packedEnchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        return (bitset & (1n << BigInt(enchantId))) === 0n;
    });
}

export function isEnchantmentAchievable(
    state: RegistryState,
    fullName: string,
    item: string,
    levels: number[],
    cache?: { getPool(v: string, k: string): PackedEnchant[] | undefined; setPool(v: string, k: string, val: PackedEnchant[]): void },
    version?: string
): boolean {
    const parsed = EnchantUtils.parse(fullName, state.romanMap);
    if (!parsed) return false;
    const targetId = state.idMap.get(parsed.name);
    if (targetId === undefined) return false;
    const targetRank = parsed.rank;

    for (const ml of levels) {
        const pool = getEligiblePool(state, item, ml, cache, version);
        if (pool.some(p => (p >> PACKING_CONSTANTS.ENCHANT_SHIFT) === targetId && (p & PACKING_CONSTANTS.RANK_MASK) === targetRank)) return true;
    }
    return false;
}

export function getEnchantability(state: RegistryState, material: string, item: string): number {
    if (!isMaterialEligible(state, item, material)) {
        throw new Error(`Material "${material}" is not available for item "${item}" in version ${state.version}.`);
    }
    const tableName = state.itemEnchantability[item];
    if (tableName === undefined) throw new Error(`Unknown item "${item}"`);
    const table = state.materialValues[tableName];
    const value = table[material];
    if (value === undefined) throw new Error(`Unknown material "${material}" for item "${item}"`);
    return value;
}

function sortMaterials(priors: readonly string[], mats: string[]): string[] {
    return mats.sort((a, b) => {
        const ai = priors.indexOf(a);
        const bi = priors.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.localeCompare(b);
    });
}
