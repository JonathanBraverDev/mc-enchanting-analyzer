/** Maps rank display strings to numeric rank values. */
export interface RomanMap {
  [key: string]: number;
}

/** Branded type for numeric enchantment packed values (id << 8 | rank). */
export type NumericEnchant = number & { readonly __brand: unique symbol };

/** Maps rank names to [minXP, maxXP] level ranges for an enchantment. */
export interface EnchantmentLevels {
  [rank: string]: [number, number];
}

/**
 * Definition of an enchantment from data files.
 * @property weight Relative weight for selection (higher = more likely).
 * @property levels Rank-to-level-range mappings.
 * @property conflicts List of enchantment names that conflict with this one.
 * @property valid_from Earliest version where this enchantment is available.
 * @property valid_to Latest version where this enchantment is available.
 * @property bookable Whether this enchantment can appear on enchanted books.
 */
export interface Enchantment {
  weight: number;
  levels: EnchantmentLevels;
  conflicts?: string[];
  valid_from?: string;
  valid_to?: string;
  bookable?: boolean;
}

/**
 * Game mechanics configuration for a version.
 * @property enchantability_bonus_divisor Divisor for the enchantability stat (default 15).
 * @property random_bonus_range Range of random multiplier applied to base modified level.
 * @property xp_cost_type How XP costs are calculated (full or flat).
 * @property lapis_required Whether the enchantment requires lapis lazuli.
 */
export interface VersionMechanics {
  enchantability_bonus_divisor?: number;
  random_bonus_range?: number;
  xp_cost_type?: 'full' | 'flat';
  lapis_required?: boolean;
}

/**
 * Version-specific enchantment configuration.
 * Supports inheritance and overrides for progressive version refinement.
 * @property extends Parent version to inherit enchantments from.
 * @property item_enchantments Maps categories to lists of enchantments available on them.
 * @property materials Available materials for this version.
 * @property mechanics Game mechanics changes.
 * @property multi_enchant_books Whether enchanted books can have multiple enchantments.
 * @property overrides Partial enchantment definitions to override inherited values.
 */
export interface VersionManifest {
  extends?: string;
  item_enchantments?: {
    [category: string]: string[];
  };
  materials?: string[];
  mechanics?: VersionMechanics;
  multi_enchant_books?: boolean;
  overrides?: {
    [enchantment: string]: Partial<Enchantment>;
  };
}

/**
 * Complete enchantment dataset loaded from data files.
 * Includes global enchantment definitions, version-specific overrides,
 * material weights, constants, and cosmetics (colors, display tweaks).
 */
export interface EnchantmentData {
  global_enchantments: {
    [name: string]: Enchantment;
  };
  enchantment_groups: {
    [groupName: string]: string[];
  };
  versions: {
    [version: string]: VersionManifest;
  };
  material_values: {
    tools: { [material: string]: number };
    armor: { [material: string]: number };
  };
  constants: {
    ROMAN_MAP: RomanMap;
    ARMOR_CATS: string[];
    MATERIAL_PRIORITY: string[];
    ITEM_SPECIFIC_CATS: string[];
  };
  cosmetics: {
    RANK_LIGHTNESS_BOOST: { [rank: string]: number };
    ENCHANT_COLORS: { [enchantment: string]: string };
  };
}
