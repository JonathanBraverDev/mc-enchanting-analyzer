import type { EnchantmentData } from '#types/index.js';

export const category_pool_rules = [
  { category: "sword", valid_from: "1.0", valid_until: "1.8", groups: ["legacy_sword_pool"] },
  { category: "sword", valid_from: "1.8", groups: ["sword_pool"] },
  { category: "pickaxe", valid_from: "1.0", groups: ["tool_pool"] },
  { category: "axe", valid_from: "1.0", groups: ["tool_pool"] },
  { category: "shovel", valid_from: "1.0", groups: ["tool_pool"] },

  { category: "helmet", valid_from: "1.0", valid_until: "1.7.2", groups: ["legacy_armor_pool", "helmet_extras"] },
  { category: "helmet", valid_from: "1.7.2", groups: ["armor_pool", "helmet_extras"] },
  { category: "chestplate", valid_from: "1.0", valid_until: "1.4.6", groups: ["legacy_armor_pool"] },
  { category: "chestplate", valid_from: "1.4.6", valid_until: "1.7.2", groups: ["legacy_armor_pool", "chestplate_extras"] },
  { category: "chestplate", valid_from: "1.7.2", groups: ["armor_pool", "chestplate_extras"] },
  { category: "leggings", valid_from: "1.0", valid_until: "1.7.2", groups: ["legacy_armor_pool"] },
  { category: "leggings", valid_from: "1.7.2", groups: ["armor_pool"] },
  { category: "boots", valid_from: "1.0", valid_until: "1.7.2", groups: ["legacy_armor_pool", "boot_extras"] },
  { category: "boots", valid_from: "1.7.2", groups: ["armor_pool", "boot_extras"] },

  { category: "bow", valid_from: "1.1", valid_until: "1.8", groups: ["legacy_bow_pool"] },
  { category: "bow", valid_from: "1.8", groups: ["bow_pool"] },
  { category: "book", valid_from: "1.4.6" },
  { category: "fishing_rod", valid_from: "1.7.2", groups: ["fishing_pool"] },
  { category: "trident", valid_from: "1.13", groups: ["trident_pool"] },
  { category: "crossbow", valid_from: "1.14", groups: ["crossbow_pool"] },
  { category: "hoe", valid_from: "1.16", groups: ["tool_pool"] },
  { category: "mace", valid_from: "1.21", groups: ["mace_pool"] },
  { category: "spear", valid_from: "1.21.11", groups: ["spear_pool"] }
] satisfies EnchantmentData["category_pool_rules"];

export const material_rules = [
  { material: "wood", valid_from: "1.0" },
  { material: "stone", valid_from: "1.0" },
  { material: "iron", valid_from: "1.0" },
  { material: "gold", valid_from: "1.0" },
  { material: "diamond", valid_from: "1.0" },
  { material: "leather", valid_from: "1.0" },
  { material: "chain", valid_from: "1.0" },
  { material: "bow", valid_from: "1.1" },
  { material: "book", valid_from: "1.4.6" },
  { material: "fishing_rod", valid_from: "1.7.2" },
  { material: "trident", valid_from: "1.13" },
  { material: "turtle_shell", valid_from: "1.13" },
  { material: "crossbow", valid_from: "1.14" },
  { material: "netherite", valid_from: "1.16" },
  { material: "mace", valid_from: "1.21" },
  { material: "copper", valid_from: "1.21.9" }
] satisfies EnchantmentData["material_rules"];
