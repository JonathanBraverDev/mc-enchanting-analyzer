import { RegistryState } from '#types/index.js';
import { EnchantUtils } from '#utils/index.js';
import { getEnchantId } from '#core/registry.js';

/**
 * Centralized service for validating and parsing enchantment clues.
 * Ensures consistent behavior across the search engine and workers.
 */
export class ClueValidator {
    /**
     * Validates a clue string against the registry and returns its packed representation.
     * Throws an error if the clue is invalid.
     * 
     * @param registry Resolved registry state.
     * @param cat Item category.
     * @param clue The clue string (e.g., "Sharpness IV").
     * @returns Packed clue ID (enchantId << 8 | rank).
     */
    public static validate(registry: RegistryState, cat: string, clue: string): number {
        const romanMap = registry.data.constants.ROMAN_MAP;
        const parsed = EnchantUtils.parse(clue, romanMap);
        
        if (!parsed) {
            throw new Error(`Invalid clue format: "${clue}"`);
        }
        
        const enchantId = getEnchantId(registry, parsed.name);
        if (enchantId === 0 && parsed.name.toLowerCase() !== 'none') {
            // Check if it's a valid enchant name but just not in the registry
            throw new Error(`Unknown enchantment: "${parsed.name}"`);
        }

        const rank = parsed.rank ?? 1;
        
        // Basic rank validation (e.g., Sharpness VI is invalid in standard Minecraft)
        // We could add more strict validation here if needed.

        return (enchantId << 8) | rank;
    }
}
