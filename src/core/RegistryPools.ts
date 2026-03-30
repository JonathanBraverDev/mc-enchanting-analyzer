import { LRUCache, RomanUtils } from '../utils/index.js';
import { PackedEnchant, RegistryState } from '../types/index.js';
import { ENGINE_DEFAULTS } from './config.js';

/**
 * Service for managing enchantment pools and checking achievability.
 * Operates on RegistryState to avoid circular dependencies with the Registry class.
 */
export class PoolService {
    private static poolCache = new LRUCache<string, PackedEnchant[]>(200);

    /**
     * Returns the eligible pool of enchantments for a given category, level, and material for the given state.
     */
    public static getEligiblePool(
        state: RegistryState,
        cat: string,
        level: number,
        mat: string
    ): PackedEnchant[] {
        const cacheKey = `${state.version}|${cat}|${level}|${mat}`;
        const cached = this.poolCache.get(cacheKey);
        if (cached) return cached;

        const pool = state.versionPool.get(cat) || [];
        const out: PackedEnchant[] = [];
        
        for (const name of pool) {
            const props = state.resolvedRegistry[name];
            const id = state.idMap.get(name)!;
            
            for (const [r, rankVal] of state.sortedRanks) {
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

    /**
     * Checks if a specific enchantment is achievable with the given parameters.
     */
    public static isEnchantmentAchievable(
        state: RegistryState,
        fullName: string,
        cat: string,
        mat: string,
        levels: number[],
        romanMap: { [key: string]: number }
    ): boolean {
        for (const ml of levels) {
            const pool = this.getEligiblePool(state, cat, ml, mat);
            if (pool.some(p => {
                const id = p >> 8;
                const rank = p & 0xFF;
                const name = state.revIdMap[id] || "Unknown";
                const rankRoman = RomanUtils.rankToRoman(rank, romanMap);
                return `${name} ${rankRoman}` === fullName;
            })) return true;
        }
        return false;
    }
}
