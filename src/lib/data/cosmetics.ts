import type { EnchantmentData } from '#types/index.js';

export const constants = {
  "ROMAN_MAP": { "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7, "VIII": 8, "IX": 9, "X": 10 },
  "MATERIAL_PRIORITY": ["netherite", "diamond", "gold", "iron", "stone", "wood", "leather", "chain"]
} satisfies EnchantmentData["constants"];

export const cosmetics = {
  "ENCHANT_COLORS": {
    "Efficiency": "hsl(196, 82%, 60%)",
    "Unbreaking": "hsl(220, 12%, 68%)",
    "Fortune": "hsl(45, 94%, 58%)",
    "Silk Touch": "hsl(280, 72%, 68%)",
    "Sharpness": "hsl(335, 82%, 60%)",
    "Smite": "hsl(60, 82%, 68%)",
    "Bane of Arthropods": "hsl(118, 58%, 54%)",
    "Protection": "hsl(145, 58%, 56%)",
    "Fire Protection": "hsl(12, 88%, 58%)",
    "Blast Protection": "hsl(315, 70%, 62%)",
    "Projectile Protection": "hsl(215, 74%, 62%)",
    "Looting": "hsl(267, 70%, 64%)",
    "Knockback": "hsl(190, 76%, 60%)",
    "Fire Aspect": "hsl(8, 92%, 58%)",
    "Sweeping Edge": "hsl(238, 80%, 56%)",
    "Power": "hsl(345, 78%, 58%)",
    "Punch": "hsl(195, 76%, 64%)",
    "Flame": "hsl(22, 92%, 58%)",
    "Infinity": "hsl(292, 80%, 68%)",
    "Luck of the Sea": "hsl(190, 80%, 58%)",
    "Lure": "hsl(82, 76%, 56%)",
    "Respiration": "hsl(198, 58%, 74%)",
    "Aqua Affinity": "hsl(170, 82%, 58%)",
    "Thorns": "hsl(335, 70%, 60%)",
    "Depth Strider": "hsl(185, 78%, 44%)",
    "Loyalty": "hsl(342, 64%, 64%)",
    "Impaling": "hsl(176, 74%, 46%)",
    "Riptide": "hsl(214, 80%, 62%)",
    "Channeling": "hsl(58, 100%, 62%)",
    "Density": "hsl(276, 58%, 54%)",
    "Breach": "hsl(215, 72%, 58%)",
    "Lunge": "hsl(30, 74%, 62%)",
    "Quick Charge": "hsl(50, 95%, 60%)",
    "Multishot": "hsl(156, 70%, 52%)",
    "Piercing": "hsl(230, 74%, 62%)",
    "Feather Falling": "hsl(255, 42%, 76%)"
  }
} satisfies EnchantmentData["cosmetics"];
