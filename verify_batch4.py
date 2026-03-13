
from data_manager import DataManager
import json

def verify():
    dm = DataManager()
    
    results = {}

    # 1. Verify 1.21 - Mace pool + Axe restriction
    dm.update_context("1.21")
    results["1.21_mace_enchants"] = [e.name for e in dm.category_enchants.get("mace", [])]
    results["1.21_axe_enchants_in_table"] = [e.name for e in dm.category_enchants.get("axe", [])]
    results["1.21_axe_has_sharpness"] = "Sharpness" in [e.name for e in dm.category_enchants.get("axe", [])]

    # 2. Verify 1.21.9 - Copper
    dm.update_context("1.21.9")
    results["1.21.9_copper_tool_enchantability"] = dm.available_materials["copper"]["tools"]
    results["1.21.9_copper_armor_enchantability"] = dm.available_materials["copper"]["armor"]

    # 3. Verify 1.21.11 - Spear pool + Tiered logic
    dm.update_context("1.21.11")
    results["1.21.11_spear_enchants"] = [e.name for e in dm.category_enchants.get("spear", [])]
    results["1.21.11_wood_spear_val"] = dm.get_material_value("wood", "spear")
    results["1.21.11_gold_spear_val"] = dm.get_material_value("gold", "spear")

    print("---BATCH4_VERIFY_START---")
    print(json.dumps(results, indent=2))
    print("---BATCH4_VERIFY_END---")

if __name__ == "__main__":
    verify()
