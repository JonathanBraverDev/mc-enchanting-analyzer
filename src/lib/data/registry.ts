import { global_enchantments, conflict_edges, enchantment_groups } from '#data/enchantments.js';
import { versions } from '#data/versions.js';
import { material_values } from '#data/materials.js';
import { constants, cosmetics } from '#data/cosmetics.js';
import { EnchantmentData } from '#types/index.js';

export const RAW_DATA: EnchantmentData = {
  global_enchantments,
  conflict_edges,
  enchantment_groups,
  versions,
  material_values,
  constants,
  cosmetics
};
