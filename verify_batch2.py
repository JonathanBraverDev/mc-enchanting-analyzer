
from data_manager import DataManager
import json

def verify():
    dm = DataManager()
    
    results = {}

    # 1. Verify 1.7.2 - Unbreaking on Armor/Fishing, but NOT Swords/Bows
    dm.update_context("1.7.2")
    results["1.7.2_sword_has_unbreaking"] = "Unbreaking" in [e.name for e in dm.category_enchants.get("sword", [])]
    results["1.7.2_bow_has_unbreaking"] = "Unbreaking" in [e.name for e in dm.category_enchants.get("bow", [])]
    results["1.7.2_helmet_has_unbreaking"] = "Unbreaking" in [e.name for e in dm.category_enchants.get("helmet", [])]
    results["1.7.2_fishing_rod_enchants"] = [e.name for e in dm.category_enchants.get("fishing_rod", [])]

    # 2. Verify 1.8 - Unbreaking joins Swords/Bows. Depth Strider available.
    dm.update_context("1.8")
    results["1.8_sword_has_unbreaking"] = "Unbreaking" in [e.name for e in dm.category_enchants.get("sword", [])]
    results["1.8_bow_has_unbreaking"] = "Unbreaking" in [e.name for e in dm.category_enchants.get("bow", [])]
    results["1.8_boots_has_depth_strider"] = "Depth Strider" in [e.name for e in dm.category_enchants.get("boots", [])]

    # 3. Verify 1.9 - Frost Walker / Mending NOT in table
    dm.update_context("1.9")
    results["1.9_boots_has_frost_walker"] = "Frost Walker" in [e.name for e in dm.category_enchants.get("boots", [])]
    results["1.9_sword_has_mending"] = "Mending" in [e.name for e in dm.category_enchants.get("sword", [])]

    # 4. Verify 1.11.1 - Sweeping Edge
    dm.update_context("1.11.1")
    results["1.11.1_sword_has_sweeping"] = "Sweeping Edge" in [e.name for e in dm.category_enchants.get("sword", [])]

    print("---BATCH2_VERIFY_START---")
    print(json.dumps(results, indent=2))
    print("---BATCH2_VERIFY_END---")

if __name__ == "__main__":
    verify()
