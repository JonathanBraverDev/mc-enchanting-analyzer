import type { EnchantmentData } from '#types/index.js';

export const versions = {
  "1.0": {
    "item_enchantments": {
      "sword": ["legacy_sword_pool"],
      "pickaxe": ["tool_pool"],
      "axe": ["tool_pool"],
      "shovel": ["tool_pool"],
      "helmet": ["legacy_armor_pool", "helmet_extras"],
      "chestplate": ["legacy_armor_pool"],
      "leggings": ["legacy_armor_pool"],
      "boots": ["legacy_armor_pool", "boot_extras"]
    },
    "materials": ["wood", "stone", "iron", "gold", "diamond", "leather", "chain"],
    "mechanics": {
      "enchantability_bonus_divisor": 2,
      "random_bonus_range": 0.25,
      "xp_cap": 50,
      "xp_cost_type": "full",
      "lapis_required": false
    }
  },
  "1.1": {
    "extends": "1.0",
    "item_enchantments": {
      "bow": ["legacy_bow_pool"]
    },
    "materials": ["bow"]
  },
  "1.3.1": {
    "extends": "1.1",
    "mechanics": {
      "enchantability_bonus_divisor": 4,
      "random_bonus_range": 0.15,
      "xp_cap": 30
    }
  },
  "1.4.6": {
    "extends": "1.3.1",
    "item_enchantments": {
      "chestplate": ["legacy_armor_pool", "chestplate_extras"],
      "book": []
    },
    "materials": ["book"],
    "multi_enchant_books": false
  },
  "1.7.2": {
    "extends": "1.4.6",
    "item_enchantments": {
      "helmet": ["armor_pool", "helmet_extras"],
      "chestplate": ["armor_pool", "chestplate_extras"],
      "leggings": ["armor_pool"],
      "boots": ["armor_pool", "boot_extras"],
      "fishing_rod": ["fishing_pool"]
    },
    "materials": ["fishing_rod"],
    "multi_enchant_books": true
  },
  "1.8": {
    "extends": "1.7.2",
    "item_enchantments": {
      "sword": ["sword_pool"],
      "bow": ["bow_pool"]
    },
    "mechanics": {
      "xp_cost_type": "flat",
      "lapis_required": true
    }
  },
  "1.11.1": {
    "extends": "1.8"
  },
  "1.13": {
    "extends": "1.11.1",
    "item_enchantments": {
      "trident": ["trident_pool"]
    },
    "materials": ["trident", "turtle_shell"]
  },
  "1.14": {
    "extends": "1.13",
    "item_enchantments": {
      "crossbow": ["crossbow_pool"]
    },
    "materials": ["crossbow"]
  },
  "1.14.3": {
    "extends": "1.14"
  },
  "1.16": {
    "extends": "1.14.3",
    "item_enchantments": {
      "hoe": ["tool_pool"]
    },
    "materials": ["netherite"]
  },
  "1.21": {
    "extends": "1.16",
    "item_enchantments": {
      "mace": ["mace_pool"]
    },
    "materials": ["mace"]
  },
  "1.21.9": {
    "extends": "1.21",
    "materials": ["copper"]
  },
  "1.21.11": {
    "extends": "1.21.9",
    "item_enchantments": {
      "spear": ["spear_pool"]
    },
    "materials": ["wood", "stone", "copper", "iron", "gold", "diamond", "netherite"]
  }
} satisfies EnchantmentData["versions"];
