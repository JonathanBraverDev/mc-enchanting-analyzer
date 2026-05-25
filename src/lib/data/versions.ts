import type { EnchantmentData } from '#types/index.js';

export const versions = {
  "1.0": {
    "mechanics": {
      "enchantability_bonus_divisor": 2,
      "additional_enchantment_level_divisor": 4,
      "random_bonus_range": 0.25,
      "xp_cap": 50,
      "xp_cost_type": "full",
      "lapis_required": false
    }
  },
  "1.3.1": {
    "extends": "1.0",
    "mechanics": {
      "enchantability_bonus_divisor": 4,
      "additional_enchantment_level_divisor": 2,
      "random_bonus_range": 0.15,
      "xp_cap": 30
    }
  },
  "1.4.6": {
    "extends": "1.3.1",
    "multi_enchant_books": false
  },
  "1.7.2": {
    "extends": "1.4.6",
    "multi_enchant_books": true
  },
  "1.8": {
    "extends": "1.7.2",
    "mechanics": {
      "xp_cost_type": "flat",
      "lapis_required": true
    }
  }
} satisfies EnchantmentData["versions"];
