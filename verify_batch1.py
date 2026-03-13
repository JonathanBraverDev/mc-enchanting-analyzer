
from data_manager import DataManager
import json

def verify():
    dm = DataManager()
    
    results = {}

    # 1. Verify 1.0 - No Unbreaking on Armor/Swords
    dm.update_context("1.0")
    results["1.0_sword_has_unbreaking"] = "Unbreaking" in dm.category_enchants.get("sword", [])
    results["1.0_helmet_has_unbreaking"] = "Unbreaking" in dm.category_enchants.get("helmet", [])
    results["1.0_bow_available"] = "bow" in dm.available_materials

    # 2. Verify 1.1 - Bow available
    dm.update_context("1.1")
    results["1.1_bow_available"] = "bow" in dm.available_materials
    results["1.1_bow_enchants"] = [e.name for e in dm.category_enchants.get("bow", [])]

    # 3. Verify 1.4.6 - Thorns on Chestplate
    dm.update_context("1.4.6")
    results["1.4.6_chestplate_has_thorns"] = "Thorns" in [e.name for e in dm.category_enchants.get("chestplate", [])]

    # 4. Verify 1.7.2 - Unbreaking joins Armor/Swords
    dm.update_context("1.7.2")
    results["1.7.2_sword_has_unbreaking"] = "Unbreaking" in [e.name for e in dm.category_enchants.get("sword", [])]
    results["1.7.2_helmet_has_unbreaking"] = "Unbreaking" in [e.name for e in dm.category_enchants.get("helmet", [])]

    print("---BATCH1_VERIFY_START---")
    print(json.dumps(results, indent=2))
    print("---BATCH1_VERIFY_END---")

if __name__ == "__main__":
    verify()
