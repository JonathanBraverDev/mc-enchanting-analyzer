import { global_enchantments } from '#data/enchantments.js';
import { conflict_rules, enchantment_group_rules, category_pool_rules, material_rules, category_material_rules } from '#data/registry-rules.js';
import { versions } from '#data/versions.js';
import { material_values } from '#data/materials.js';
import { constants, cosmetics } from '#data/cosmetics.js';
import { EnchantmentData } from '#types/index.js';

export const RAW_DATA: EnchantmentData = {
  global_enchantments,
  conflict_rules,
  enchantment_group_rules,
  category_pool_rules,
  material_rules,
  category_material_rules,
  versions,
  material_values,
  constants,
  cosmetics
};
