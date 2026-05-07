import type { EnchantmentData } from '#types/index.js';

export const constants = {
  "ROMAN_MAP": { "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7, "VIII": 8, "IX": 9, "X": 10 },
  "ARMOR_CATS": ["helmet", "chestplate", "leggings", "boots"],
  "MATERIAL_PRIORITY": ["netherite", "diamond", "gold", "iron", "stone", "wood", "leather", "chain"]
} satisfies EnchantmentData["constants"];

export const cosmetics = {
  "RANK_LIGHTNESS_BOOST": { "I": 0, "II": 5, "III": 10, "IV": 15, "V": 20, "VI": 25, "VII": 30, "VIII": 35, "IX": 40, "X": 45 },
  "ENCHANT_COLORS": {
    "Efficiency": "hsl(200, 70%, 60%)",
    "Unbreaking": "hsl(0, 70%, 60%)",
    "Fortune": "hsl(45, 80%, 60%)",
    "Silk Touch": "hsl(280, 70%, 60%)",
    "Sharpness": "hsl(0, 80%, 50%)",
    "Smite": "hsl(30, 70%, 50%)",
    "Bane of Arthropods": "hsl(120, 60%, 40%)",
    "Protection": "hsl(145, 60%, 50%)",
    "Fire Protection": "hsl(15, 80%, 50%)",
    "Blast Protection": "hsl(0, 0%, 50%)",
    "Projectile Protection": "hsl(210, 60%, 50%)",
    "Looting": "hsl(260, 60%, 60%)",
    "Knockback": "hsl(180, 50%, 50%)",
    "Fire Aspect": "hsl(10, 90%, 50%)",
    "Sweeping Edge": "hsl(240, 50%, 60%)",
    "Power": "hsl(30, 80%, 60%)",
    "Punch": "hsl(210, 70%, 60%)",
    "Flame": "hsl(15, 90%, 60%)",
    "Infinity": "hsl(280, 80%, 70%)",
    "Luck of the Sea": "hsl(200, 80%, 70%)",
    "Lure": "hsl(180, 70%, 60%)",
    "Respiration": "hsl(190, 60%, 70%)",
    "Aqua Affinity": "hsl(180, 90%, 70%)",
    "Thorns": "hsl(340, 70%, 60%)",
    "Depth Strider": "hsl(220, 70%, 60%)",
    "Loyalty": "hsl(45, 70%, 60%)",
    "Impaling": "hsl(190, 80%, 50%)",
    "Riptide": "hsl(200, 50%, 80%)",
    "Channeling": "hsl(50, 100%, 70%)",
    "Density": "hsl(260, 50%, 50%)",
    "Breach": "hsl(10, 60%, 40%)",
    "Lunge": "hsl(40, 80%, 50%)",
    "Quick Charge": "hsl(40, 90%, 60%)",
    "Multishot": "hsl(170, 60%, 55%)",
    "Piercing": "hsl(210, 40%, 55%)",
    "Feather Falling": "hsl(250, 60%, 75%)"
  }
} satisfies EnchantmentData["cosmetics"];
