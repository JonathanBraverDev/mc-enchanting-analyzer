import type { EnchantmentData } from '#types/index.js';

export const material_values = {
  "tool": {
    "wood": 15, "stone": 5, "iron": 14, "diamond": 10, "gold": 22, "netherite": 15, "copper": 13
  },
  "armor": {
    "leather": 15, "chain": 12, "iron": 9, "diamond": 10, "gold": 25, "netherite": 15, "turtle_shell": 9, "copper": 8
  },
  "other": {
    "book": 1, "bow": 1, "crossbow": 1, "fishing_rod": 1, "trident": 1, "mace": 15
  }
} satisfies EnchantmentData["material_values"];
