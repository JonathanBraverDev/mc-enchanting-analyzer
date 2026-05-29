/**
 * Maps rank display strings to numeric rank values.
 *
 * @public
 */
export interface RomanMap {
  [key: string]: number;
}

/** Branded type for numeric enchantment packed values (id << 8 | rank). */
export type NumericEnchant = number & { readonly __brand: unique symbol };

/**
 * Maps rank names to [minXP, maxXP] level ranges for an enchantment.
 *
 * @public
 */
export interface EnchantmentLevels {
  [rank: string]: [number, number];
}

/**
 * Definition of an enchantment from data files.
 * @property weight Relative weight for selection (higher = more likely).
 * @property levels Rank-to-level-range mappings.
 * @property valid_from First version where this enchantment is available, inclusive.
 * @property valid_until First version where this enchantment is no longer available, exclusive.
 *
 * @public
 */
export interface Enchantment {
  weight: number;
  levels: EnchantmentLevels;
  valid_from?: string;
  valid_until?: string;
}

/**
 * Version-ranged conflict rule between two enchantments.
 * Conflict rules are unordered pairs and are compiled into symmetric bitsets.
 * @property valid_from First version where this conflict applies, inclusive.
 * @property valid_until First version where this conflict no longer applies, exclusive.
 *
 * @public
 */
export interface ConflictRule {
  enchants: [string, string];
  valid_from: string;
  valid_until?: string;
}

/**
 * Version-ranged material rule.
 * @property valid_from First version where this material rule applies, inclusive.
 * @property valid_until First version where this material rule no longer applies, exclusive.
 *
 * @public
 */
export interface MaterialRule {
  material: string;
  valid_from: string;
  valid_until?: string;
}

/**
 * Version-ranged membership rule for an enchantment group.
 * Active rules for the same group are unioned in declaration order.
 * @property valid_from First version where this membership rule applies, inclusive.
 * @property valid_until First version where this membership rule no longer applies, exclusive.
 *
 * @public
 */
export interface EnchantmentGroupRule {
  group: string;
  enchantments: string[];
  valid_from: string;
  valid_until?: string;
}

/**
 * Named material aliases used by enchantable item rules.
 * Each entry expands to concrete material keys declared by material rules.
 *
 * @public
 */
export interface MaterialSets {
  [set: string]: string[];
}

/** @public */
export type EnchantabilityTable = 'tool' | 'armor' | 'other';

/** @public */
export interface MaterialValues {
  tool: { [material: string]: number };
  armor: { [material: string]: number };
  other: { [material: string]: number };
}

/**
 * Version-ranged enchantable item rule.
 * Missing groups means the item uses every active table enchantment.
 * That derived mode is currently valid only for enchanted books.
 * Materials may reference concrete material keys or material set aliases.
 * Enchantability selects the material-value table used by this item.
 * @property valid_from First version where this item rule applies, inclusive.
 * @property valid_until First version where this item rule no longer applies, exclusive.
 *
 * @public
 */
export interface EnchantableItemRule {
  item: string;
  valid_from: string;
  valid_until?: string;
  groups?: string[];
  materials: string[];
  enchantability: EnchantabilityTable;
}

/** @public */
export type ConflictRuleSelector = Pick<ConflictRule, 'enchants' | 'valid_from' | 'valid_until'>;
/** @public */
export type EnchantmentGroupRuleSelector = Pick<EnchantmentGroupRule, 'group' | 'valid_from' | 'valid_until'>;
/** @public */
export type MaterialRuleSelector = Pick<MaterialRule, 'material' | 'valid_from' | 'valid_until'>;
/** @public */
export type EnchantableItemRuleSelector = Pick<EnchantableItemRule, 'item' | 'valid_from' | 'valid_until'>;

/**
 * Small vanilla-data mutations for vanilla registry variants.
 * These operate on version-ranged rule tables only and are applied to a cloned
 * vanilla data pack before the resolved registry is built.
 *
 * @public
 */
export type RegistryMutation =
  | { type: 'patchEnchantment'; enchantment: string; patch: Partial<Enchantment> }
  | { type: 'addConflictRule'; rule: ConflictRule }
  | { type: 'removeConflictRule'; selector: ConflictRuleSelector }
  | { type: 'addEnchantmentGroupRule'; rule: EnchantmentGroupRule }
  | { type: 'removeEnchantmentGroupRule'; selector: EnchantmentGroupRuleSelector }
  | { type: 'addMaterialRule'; rule: MaterialRule }
  | { type: 'removeMaterialRule'; selector: MaterialRuleSelector }
  | { type: 'addEnchantableItemRule'; rule: EnchantableItemRule }
  | { type: 'removeEnchantableItemRule'; selector: EnchantableItemRuleSelector };

/**
 * Game mechanics configuration for a version.
 * @property enchantability_bonus_divisor Divisor for the enchantability stat (default 15).
 * @property additional_enchantment_level_divisor Divisor applied to modified level before rolling additional enchantments.
 * @property random_bonus_range Range of random multiplier applied to base modified level.
 * @property xp_cost_type How XP costs are calculated (full or flat).
 * @property lapis_required Whether the enchantment requires lapis lazuli.
 *
 * @public
 */
export interface VersionMechanics {
  enchantability_bonus_divisor?: number;
  additional_enchantment_level_divisor?: number;
  random_bonus_range?: number;
  xp_cost_type?: 'full' | 'flat';
  lapis_required?: boolean;
  xp_cap?: number;
}

/**
 * Version-specific enchantment configuration.
 * Supports inheritance and overrides for progressive version refinement.
 * @property extends Parent version to inherit enchantments from.
 * @property mechanics Game mechanics changes.
 * @property multi_enchant_books Whether enchanted books can have multiple enchantments.
 * @property overrides Partial enchantment definitions to override inherited values.
 *
 * @public
 */
export interface VersionManifest {
  extends?: string;
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
 *
 * @public
 */
export interface EnchantmentData {
  global_enchantments: {
    [name: string]: Enchantment;
  };
  conflict_rules: ConflictRule[];
  enchantment_group_rules: EnchantmentGroupRule[];
  enchantable_item_rules: EnchantableItemRule[];
  material_rules: MaterialRule[];
  material_sets: MaterialSets;
  versions: {
    [version: string]: VersionManifest;
  };
  material_values: MaterialValues;
  constants: {
    ROMAN_MAP: RomanMap;
    MATERIAL_PRIORITY: string[];
  };
  cosmetics: {
    RANK_LIGHTNESS_BOOST: { [rank: string]: number };
    ENCHANT_COLORS: { [enchantment: string]: string };
  };
}
