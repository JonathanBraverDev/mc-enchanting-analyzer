import type { EnchantmentData } from '#types/index.js';

export const conflict_rules = [
  { enchants: ["Sharpness", "Smite"], valid_from: "1.0" },
  { enchants: ["Sharpness", "Bane of Arthropods"], valid_from: "1.0" },
  { enchants: ["Smite", "Bane of Arthropods"], valid_from: "1.0" },

  { enchants: ["Protection", "Fire Protection"], valid_from: "1.0", valid_until: "1.14" },
  { enchants: ["Protection", "Blast Protection"], valid_from: "1.0", valid_until: "1.14" },
  { enchants: ["Protection", "Projectile Protection"], valid_from: "1.0", valid_until: "1.14" },
  { enchants: ["Fire Protection", "Blast Protection"], valid_from: "1.0", valid_until: "1.14" },
  { enchants: ["Fire Protection", "Projectile Protection"], valid_from: "1.0", valid_until: "1.14" },
  { enchants: ["Blast Protection", "Projectile Protection"], valid_from: "1.0", valid_until: "1.14" },

  { enchants: ["Fortune", "Silk Touch"], valid_from: "1.0" },

  { enchants: ["Impaling", "Sharpness"], valid_from: "1.13" },
  { enchants: ["Impaling", "Smite"], valid_from: "1.13" },
  { enchants: ["Impaling", "Bane of Arthropods"], valid_from: "1.13" },
  { enchants: ["Riptide", "Loyalty"], valid_from: "1.13" },
  { enchants: ["Riptide", "Channeling"], valid_from: "1.13" },

  { enchants: ["Protection", "Fire Protection"], valid_from: "1.14.3" },
  { enchants: ["Protection", "Blast Protection"], valid_from: "1.14.3" },
  { enchants: ["Protection", "Projectile Protection"], valid_from: "1.14.3" },
  { enchants: ["Fire Protection", "Blast Protection"], valid_from: "1.14.3" },
  { enchants: ["Fire Protection", "Projectile Protection"], valid_from: "1.14.3" },
  { enchants: ["Blast Protection", "Projectile Protection"], valid_from: "1.14.3" },

  { enchants: ["Multishot", "Piercing"], valid_from: "1.14" },

  { enchants: ["Density", "Sharpness"], valid_from: "1.21" },
  { enchants: ["Density", "Smite"], valid_from: "1.21" },
  { enchants: ["Density", "Bane of Arthropods"], valid_from: "1.21" },
  { enchants: ["Density", "Impaling"], valid_from: "1.21" },
  { enchants: ["Density", "Breach"], valid_from: "1.21" },
  { enchants: ["Breach", "Sharpness"], valid_from: "1.21" },
  { enchants: ["Breach", "Smite"], valid_from: "1.21" },
  { enchants: ["Breach", "Bane of Arthropods"], valid_from: "1.21" },
  { enchants: ["Breach", "Impaling"], valid_from: "1.21" }
] satisfies EnchantmentData["conflict_rules"];

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

const tool_materials = ["wood", "stone", "iron", "gold", "diamond", "netherite", "copper"];
const armor_materials = ["leather", "chain", "iron", "gold", "diamond", "netherite", "copper"];

export const category_material_rules = [
  { category: "sword", materials: tool_materials },
  { category: "pickaxe", materials: tool_materials },
  { category: "axe", materials: tool_materials },
  { category: "shovel", materials: tool_materials },
  { category: "hoe", materials: tool_materials },
  { category: "spear", materials: tool_materials },

  { category: "helmet", materials: [...armor_materials, "turtle_shell"] },
  { category: "chestplate", materials: armor_materials },
  { category: "leggings", materials: armor_materials },
  { category: "boots", materials: armor_materials },

  { category: "bow", materials: ["bow"] },
  { category: "book", materials: ["book"] },
  { category: "fishing_rod", materials: ["fishing_rod"] },
  { category: "trident", materials: ["trident"] },
  { category: "crossbow", materials: ["crossbow"] },
  { category: "mace", materials: ["mace"] }
] satisfies EnchantmentData["category_material_rules"];
