import { RegistryState } from '#types/index.js';
import { EnchantUtils } from '#utils/index.js';
import { getEnchantId } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';

/**
 * Shared logic for parsing and validating clue strings against a specific registry state.
 * Ensures consistent behavior between the engine and snapshot projection.
 */
export class ClueValidator {
  /**
   * Parses and validates a clue. 
   * Returns a packed clue ID (id << 8 | rank).
   * Throws Error if the clue is invalid for the given category/registry.
   */
  public static validate(registry: RegistryState, cat: string, clue: string): number {
    const romanMap = registry.data.constants.ROMAN_MAP;
    const parsed = EnchantUtils.parse(clue, romanMap);
    if (!parsed) throw new Error(`Invalid clue format: "${clue}"`);
    
    const clueId = getEnchantId(registry, parsed.name);
    if (clueId === ENGINE_LIMITS.UNKNOWN_ENCHANT_ID) {
        throw new Error(`Invalid clue format: Unknown enchantment "${parsed.name}"`);
    }

    const enchantData = registry.resolvedRegistry[parsed.name];
    if (!enchantData) {
        throw new Error(`Invalid clue format: Unknown enchantment "${parsed.name}"`);
    }

    // Check if applicable to category
    const pool = registry.mergedItems[cat] || [];
    if (!pool.includes(parsed.name)) {
        throw new Error(`Invalid clue format: Enchantment "${parsed.name}" is not applicable to category "${cat}"`);
    }

    const maxRank = Object.keys(enchantData.levels).length;
    if (parsed.rank > maxRank) {
        throw new Error(`Invalid clue format: Rank ${parsed.rank} exceeds max for ${parsed.name}`);
    }

    return (clueId << 8) | (parsed.rank ?? 1);
  }
}
