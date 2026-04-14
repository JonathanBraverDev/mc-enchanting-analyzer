import { RegistryState } from '#types/index.js';
import { getCategoryId, getMaterialId, getEnchantId } from '#core/registry.js';
import { EnchantUtils, KeyUtils } from '#utils/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';

/**
 * Service for generating complex cache keys using registry-aware lookups.
 */
export class KeyService {
    /**
     * Generates a packed key for combination calculations.
     */
    public getPackedKey(registry: RegistryState, cat: string, modLevel: number, mat: string, guaranteedFirst: string | null): number {
        const catId = getCategoryId(registry, cat);
        const matId = getMaterialId(registry, mat);
        const parsed = EnchantUtils.parse(guaranteedFirst, registry.data.constants.ROMAN_MAP);
        const guaranteedId = parsed ? getEnchantId(registry, parsed.name) : ENGINE_LIMITS.UNKNOWN_ENCHANT_ID;

        return KeyUtils.getPackedKey(catId, matId, modLevel, guaranteedId);
    }

    /**
     * Generates a packed key for full statistics calculation.
     */
    public getStatsKey(registry: RegistryState, cat: string, xp: number, mat: string, guaranteedFirst: string | null): number {
        const catId = getCategoryId(registry, cat);
        const matId = getMaterialId(registry, mat);
        const parsed = EnchantUtils.parse(guaranteedFirst, registry.data.constants.ROMAN_MAP);
        const guaranteedId = parsed ? getEnchantId(registry, parsed.name) : ENGINE_LIMITS.UNKNOWN_ENCHANT_ID;

        return KeyUtils.getStatsKey(catId, matId, xp, guaranteedId);
    }
}
