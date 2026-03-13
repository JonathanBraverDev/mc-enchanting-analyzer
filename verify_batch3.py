
from data_manager import DataManager
import json

def verify():
    dm = DataManager()
    
    results = {}

    # 1. Verify 1.13 - Trident pool + Hoe restriction
    dm.update_context("1.13")
    results["1.13_trident_enchants"] = [e.name for e in dm.category_enchants.get("trident", [])]
    results["1.13_hoe_has_table_pool"] = "hoe" in dm.category_enchants

    # 2. Verify 1.14 - Crossbow + Protection Stacking
    dm.update_context("1.14")
    results["1.14_crossbow_enchants"] = [e.name for e in dm.category_enchants.get("crossbow", [])]
    
    # Check Protection conflicts in 1.14 - should be empty/less
    prot = dm.enchant_lookup["Protection"]
    results["1.14_protection_conflicts"] = prot.conflicts

    # 3. Verify 1.14.3 - Protection Conflicts Restored
    dm.update_context("1.14.3")
    results["1.14.3_protection_conflicts"] = dm.enchant_lookup["Protection"].conflicts

    # 4. Verify 1.16 - Hoe in table + Netherite enchantability
    dm.update_context("1.16")
    results["1.16_hoe_has_table_pool"] = "hoe" in dm.category_enchants
    results["1.16_netherite_tool_enchantability"] = dm.available_materials["netherite"]["tools"]
    results["1.16_netherite_armor_enchantability"] = dm.available_materials["netherite"]["armor"]

    print("---BATCH3_VERIFY_START---")
    print(json.dumps(results, indent=2))
    print("---BATCH3_VERIFY_END---")

if __name__ == "__main__":
    verify()
