import type { EnchantmentData } from '#types/index.js';

export const global_enchantments = {
  "Sharpness": {
    "weight": 10,
    "levels": {"I": [1, 21], "II": [12, 32], "III": [23, 43], "IV": [34, 54], "V": [45, 65]},
    "valid_from": "1.0"
  },
  "Smite": {
    "weight": 5,
    "levels": {"I": [5, 25], "II": [13, 33], "III": [21, 41], "IV": [29, 49], "V": [37, 57]},
    "valid_from": "1.0"
  },
  "Bane of Arthropods": {
    "weight": 5,
    "levels": {"I": [5, 25], "II": [13, 33], "III": [21, 41], "IV": [29, 49], "V": [37, 57]},
    "valid_from": "1.0"
  },
  "Knockback": {
    "weight": 5,
    "levels": {"I": [5, 55], "II": [25, 75]},
    "valid_from": "1.0"
  },
  "Fire Aspect": {
    "weight": 2,
    "levels": {"I": [10, 60], "II": [30, 80]},
    "valid_from": "1.0"
  },
  "Looting": {
    "weight": 2,
    "levels": {"I": [15, 65], "II": [24, 74], "III": [33, 83]},
    "valid_from": "1.0"
  },
  "Unbreaking": {
    "weight": 5,
    "levels": {"I": [5, 55], "II": [13, 63], "III": [21, 71]},
    "valid_from": "1.0"
  },
  "Sweeping Edge": {
    "weight": 2,
    "levels": {"I": [5, 20], "II": [14, 29], "III": [23, 38]},
    "valid_from": "1.11.1"
  },
  "Efficiency": {
    "weight": 10,
    "levels": {"I": [1, 51], "II": [11, 61], "III": [21, 71], "IV": [31, 81], "V": [41, 91]},
    "valid_from": "1.0"
  },
  "Fortune": {
    "weight": 2,
    "levels": {"I": [15, 65], "II": [24, 74], "III": [33, 83]},
    "valid_from": "1.0"
  },
  "Silk Touch": {
    "weight": 1,
    "levels": {"I": [15, 65]},
    "valid_from": "1.0"
  },
  "Power": {
    "weight": 10,
    "levels": {"I": [1, 16], "II": [11, 26], "III": [21, 36], "IV": [31, 46], "V": [41, 56]},
    "valid_from": "1.1"
  },
  "Punch": {
    "weight": 2,
    "levels": {"I": [12, 37], "II": [32, 57]},
    "valid_from": "1.1"
  },
  "Flame": {
    "weight": 2,
    "levels": {"I": [20, 50]},
    "valid_from": "1.1"
  },
  "Infinity": {
    "weight": 1,
    "levels": {"I": [20, 50]},
    "valid_from": "1.1"
  },
  "Protection": {
    "weight": 10,
    "levels": {"I": [1, 12], "II": [12, 23], "III": [23, 34], "IV": [34, 45]},
    "valid_from": "1.0"
  },
  "Fire Protection": {
    "weight": 5,
    "levels": {"I": [10, 18], "II": [18, 26], "III": [26, 34], "IV": [34, 42]},
    "valid_from": "1.0"
  },
  "Blast Protection": {
    "weight": 2,
    "levels": {"I": [5, 13], "II": [13, 21], "III": [21, 29], "IV": [29, 37]},
    "valid_from": "1.0"
  },
  "Projectile Protection": {
    "weight": 5,
    "levels": {"I": [3, 9], "II": [9, 15], "III": [15, 21], "IV": [21, 27]},
    "valid_from": "1.0"
  },
  "Respiration": {
    "weight": 2,
    "levels": {"I": [10, 40], "II": [20, 50], "III": [30, 60]},
    "valid_from": "1.0"
  },
  "Aqua Affinity": {
    "weight": 2,
    "levels": {"I": [1, 41]},
    "valid_from": "1.0"
  },
  "Thorns": {
    "weight": 1,
    // Vanilla defines Thorns III at 50-100, but the enchanting table cannot roll a modified level that high.
    "levels": {"I": [10, 60], "II": [30, 80]},
    "valid_from": "1.4.6"
  },
  "Feather Falling": {
    "weight": 5,
    "levels": {"I": [5, 11], "II": [11, 17], "III": [17, 23], "IV": [23, 29]},
    "valid_from": "1.0"
  },
  "Depth Strider": {
    "weight": 2,
    "levels": {"I": [10, 25], "II": [20, 35], "III": [30, 45]},
    "valid_from": "1.8"
  },
  "Impaling": {
    "weight": 2,
    "levels": {"I": [1, 21], "II": [9, 29], "III": [17, 37], "IV": [25, 45], "V": [33, 53]},
    "valid_from": "1.13"
  },
  "Loyalty": {
    "weight": 5,
    "levels": {"I": [12, 50], "II": [19, 50], "III": [26, 50]},
    "valid_from": "1.13"
  },
  "Riptide": {
    "weight": 2,
    "levels": {"I": [17, 50], "II": [24, 50], "III": [31, 50]},
    "valid_from": "1.13"
  },
  "Channeling": {
    "weight": 1,
    "levels": {"I": [25, 50]},
    "valid_from": "1.13"
  },
  "Quick Charge": {
    "weight": 5,
    // Vanilla data lists Quick Charge III as 52-50, an empty interval that the table can never roll.
    "levels": {"I": [12, 50], "II": [32, 50]},
    "valid_from": "1.14"
  },
  "Multishot": {
    "weight": 2,
    "levels": {"I": [20, 50]},
    "valid_from": "1.14"
  },
  "Piercing": {
    "weight": 10,
    "levels": {"I": [1, 50], "II": [11, 50], "III": [21, 50], "IV": [31, 50]},
    "valid_from": "1.14"
  },
  "Luck of the Sea": {
    "weight": 2,
    "levels": {"I": [15, 65], "II": [24, 74], "III": [33, 83]},
    "valid_from": "1.7.2"
  },
  "Lure": {
    "weight": 2,
    "levels": {"I": [15, 65], "II": [24, 74], "III": [33, 83]},
    "valid_from": "1.7.2"
  },
  "Density": {
    "weight": 5,
    "levels": {"I": [5, 25], "II": [13, 33], "III": [21, 41], "IV": [29, 49], "V": [37, 57]},
    "valid_from": "1.21"
  },
  "Breach": {
    "weight": 2,
    "levels": {"I": [15, 65], "II": [24, 74], "III": [33, 83], "IV": [42, 92]},
    "valid_from": "1.21"
  },
  "Lunge": {
    "weight": 5,
    "levels": {"I": [5, 25], "II": [13, 33], "III": [21, 41]},
    "valid_from": "1.21.11"
  }
} satisfies EnchantmentData["global_enchantments"];

export const conflict_edges = [
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
] satisfies EnchantmentData["conflict_edges"];

export const enchantment_groups = {
  "armor_pool": ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection", "Unbreaking"],
  "legacy_armor_pool": ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"],
  "chestplate_extras": ["Thorns"],
  "boot_extras": ["Feather Falling", "Depth Strider"],
  "helmet_extras": ["Respiration", "Aqua Affinity"],
  "sword_pool": ["Sharpness", "Smite", "Bane of Arthropods", "Knockback", "Fire Aspect", "Looting", "Sweeping Edge", "Unbreaking"],
  "legacy_sword_pool": ["Sharpness", "Smite", "Bane of Arthropods", "Knockback", "Fire Aspect", "Looting"],
  "bow_pool": ["Power", "Punch", "Flame", "Infinity", "Unbreaking"],
  "legacy_bow_pool": ["Power", "Punch", "Flame", "Infinity"],
  "tool_pool": ["Efficiency", "Unbreaking", "Fortune", "Silk Touch"],
  "fishing_pool": ["Luck of the Sea", "Lure", "Unbreaking"],
  "trident_pool": ["Impaling", "Loyalty", "Riptide", "Channeling", "Unbreaking"],
  "crossbow_pool": ["Quick Charge", "Multishot", "Piercing", "Unbreaking"],
  "mace_pool": ["Density", "Breach", "Smite", "Bane of Arthropods", "Fire Aspect", "Unbreaking"],
  "spear_pool": ["Lunge", "Sharpness", "Smite", "Bane of Arthropods", "Knockback", "Fire Aspect", "Looting", "Unbreaking"]
} satisfies EnchantmentData["enchantment_groups"];
