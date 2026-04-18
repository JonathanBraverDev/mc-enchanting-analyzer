import { EnchantmentData } from '#types/index.js';
import { global_enchantments, enchantment_groups } from './enchantments.js';
import { versions } from './versions.js';
import { material_values } from './materials.js';
import { constants, cosmetics } from './cosmetics.js';

export const DATA: EnchantmentData = {
  global_enchantments: global_enchantments as unknown as EnchantmentData["global_enchantments"],
  enchantment_groups: enchantment_groups as unknown as EnchantmentData["enchantment_groups"],
  versions: versions as unknown as EnchantmentData["versions"],
  material_values: material_values as unknown as EnchantmentData["material_values"],
  constants: constants as unknown as EnchantmentData["constants"],
  cosmetics: cosmetics as unknown as EnchantmentData["cosmetics"]
};
