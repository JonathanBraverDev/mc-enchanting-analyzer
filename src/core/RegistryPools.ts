import { EnchantUtils, LRUCache } from '../utils/index.js';
import { PackedEnchant, RegistryState } from '../types/index.js';
import { ENGINE_DEFAULTS } from './config.js';

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
        mat: string,
        cache?: LRUCache<string, PackedEnchant[]>
    ): PackedEnchant[] {
        const cacheKey = `${cat}|${level}`;
        const cached = cache?.get(cacheKey);
        if (cached) return cached;

        const pool = state.versionPool.get(cat) || [];
        const out: PackedEnchant[] = [];
        
        for (const name of pool) {
            const props = state.resolvedRegistry[name];
            const id = state.idMap.get(name)!;
            
            // sortedRanks is sorted descending (highest rank first), so the first matching
            // rank is the highest one achievable at this level. The break is correct.
            for (const [r, rankVal] of state.sortedRanks) {
                const range = props.levels[r];
                if (range && level >= range[0] && level <= range[1]) {
                    out.push((id << 8) | rankVal);
                    break;
                }
            }
        }

        cache?.set(cacheKey, out);
        return out;
    }

    /**
     * Checks if a specific enchantment is achievable with the given parameters.
     */
    public static isEnchantmentAchievable(
        state: RegistryState,
        fullName: string,
        cat: string,
        mat: string,
        levels: number[],
        romanMap: { [key: string]: number },
        cache?: LRUCache<string, PackedEnchant[]>
    ): boolean {
        const parsed = EnchantUtils.parse(fullName, romanMap);
        if (!parsed) return false;
        const targetId = state.idMap.get(parsed.name);
        if (targetId === undefined) return false;
        const targetRank = parsed.rank;

        for (const ml of levels) {
            const pool = this.getEligiblePool(state, cat, ml, mat, cache);
            if (pool.some(p => (p >> 8) === targetId && (p & 0xFF) === targetRank)) return true;
        }
        return false;
    }
}
