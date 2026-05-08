import { RegistryState } from '#types/index.js';
import { EnchantUtils } from '#utils/index.js';
import { getEnchantId } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';

/**
 * Centralized service for validating and parsing enchantment clue input.
 * Ensures consistent behavior across the search engine and workers.
 */
export class ClueValidator {
    /**
     * Validates a clue string against the registry and returns its packed representation.
     * Throws an error if the clue is invalid.
     *
     * @param registry Resolved registry state.
     * @param item Item type.
     * @param clue The clue string (e.g., "Sharpness IV").
     * @returns Packed clue ID (enchantId << 8 | rank).
     */
    public static validate(registry: RegistryState, item: string, clue: string): number {
        const romanMap = registry.data.constants.ROMAN_MAP;
        const parsed = EnchantUtils.parse(clue, romanMap);

        if (!parsed) {
            throw new Error(`Invalid clue format: "${clue}"`);
        }

        const enchantId = getEnchantId(registry, parsed.name);
        if (enchantId === ENGINE_LIMITS.UNKNOWN_ENCHANT_ID && parsed.name.toLowerCase() !== 'none') {
            // Check if it's a valid enchant name but just not in the registry
            throw new Error(`Unknown enchantment: "${parsed.name}"`);
        }

        const rank = parsed.rank ?? 1;

        // Applicability check
        const versionPool = registry.versionPool.get(item);
        if (versionPool && !versionPool.includes(parsed.name) && item !== 'book') {
            throw new Error(`Enchantment "${parsed.name}" is not applicable to item "${item}"`);
        }

        // Rank bounds check
        const enchant = registry.resolvedRegistry[parsed.name];
        if (enchant) {
            const maxRank = Object.keys(enchant.levels).length;
            if (rank < 1 || rank > maxRank) {
                throw new Error(`Rank ${rank} for "${parsed.name}" exceeds max rank ${maxRank}`);
            }
        }

        return (enchantId << 8) | rank;
    }
}
