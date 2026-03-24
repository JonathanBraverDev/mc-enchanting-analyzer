export interface RomanMap {
  [key: string]: number;
}

export type NumericEnchant = number & { readonly __brand: unique symbol };

export interface EnchantmentLevels {
  [rank: string]: [number, number];
}

export interface Enchantment {
  weight: number;
  levels: EnchantmentLevels;
  conflicts?: string[];
  valid_from?: string;
  valid_to?: string;
}

export interface VersionMechanics {
  enchantability_bonus_divisor?: number;
  random_bonus_range?: number;
  xp_cost_type?: 'full' | 'flat';
  lapis_required?: boolean;
}

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
