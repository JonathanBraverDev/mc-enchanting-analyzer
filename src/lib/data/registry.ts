import { global_enchantments, conflict_edges, enchantment_groups } from '#data/enchantments.js';
import { versions } from '#data/versions.js';
import { material_values } from '#data/materials.js';
import { constants, cosmetics } from '#data/cosmetics.js';
import { EnchantmentData } from '#types/index.js';

export const RAW_DATA: EnchantmentData = {
  global_enchantments: global_enchantments as unknown as EnchantmentData["global_enchantments"],
  conflict_edges: conflict_edges as unknown as EnchantmentData["conflict_edges"],
  enchantment_groups: enchantment_groups as unknown as EnchantmentData["enchantment_groups"],
  versions: versions as unknown as EnchantmentData["versions"],
  material_values: material_values as unknown as EnchantmentData["material_values"],
  constants: constants as unknown as EnchantmentData["constants"],
  cosmetics: cosmetics as unknown as EnchantmentData["cosmetics"]
};
