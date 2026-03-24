import { EnchantmentData } from '../types/index.js';
import { global_enchantments, enchantment_groups } from './enchantments.js';
import { versions } from './versions.js';
import { material_values } from './materials.js';
import { constants, cosmetics } from './cosmetics.js';

export const DATA: EnchantmentData = {
  global_enchantments: global_enchantments as any,
  enchantment_groups: enchantment_groups as any,
  versions: versions as any,
  material_values: material_values as any,
  constants: constants as any,
  cosmetics: cosmetics as any
};
