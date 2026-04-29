import { EnchantUtils } from '../utils/index.js';
import { PackedEnchant, RegistryState } from '../types/index.js';

/**
 * Service for managing enchantment pools and checking achievability.
 */
export class PoolService {
    /**
     * Returns the eligible pool of enchantments for a given category, level, and material for the given state.
     */
    public static getEligiblePool(
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
                    out.push(((id << 8) | rankVal) as PackedEnchant);
                    break;
                }
            }
        }

        if (cache && version) cache.setPool(version, cacheKey, out);
        return out;
    }

    /**
     * Checks if a specific enchantment is achievable with the given parameters.
     */
    public static isEnchantmentAchievable(
        state: RegistryState,
        fullName: string,
        cat: string,
        levels: number[],
        romanMap: { [key: string]: number },
        cache?: { getPool(v: string, k: string): PackedEnchant[] | undefined; setPool(v: string, k: string, val: PackedEnchant[]): void },
        version?: string
    ): boolean {
        const parsed = EnchantUtils.parse(fullName, romanMap);
        if (!parsed) return false;
        const targetId = state.idMap.get(parsed.name);
        if (targetId === undefined) return false;
        const targetRank = parsed.rank;

        for (const ml of levels) {
            const pool = this.getEligiblePool(state, cat, ml, cache, version);
            if (pool.some(p => (p >> 8) === targetId && (p & 0xFF) === targetRank)) return true;
        }
        return false;
    }
}
