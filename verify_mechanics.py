
from data_manager import DataManager
from calculator import EnchantCalculator
import json

def verify_mechanics():
    dm = DataManager()
    calc = EnchantCalculator(dm)
    
    results = {}

    # Test Case: Gold Sword at Level 30
    # Gold has enchantability 22 (swords)
    
    # 1. Beta 1.0 Era
    dm.update_context("1.0")
    dist_10 = calc.get_modified_level_distribution(30, 22)
    results["1.0_gold30_stats"] = {
        "min": min(dist_10.keys()),
        "max": max(dist_10.keys()),
        "mean": sum(k * v for k, v in dist_10.items())
    }

    # 2. 1.3.1 Era (Level 30 Cap, narrow distribution)
    dm.update_context("1.3.1")
    dist_131 = calc.get_modified_level_distribution(30, 22)
    results["1.3.1_gold30_stats"] = {
        "min": min(dist_131.keys()),
        "max": max(dist_131.keys()),
        "mean": sum(k * v for k, v in dist_131.items())
    }

    # 3. 1.8 Era (Same math as 1.3.1)
    dm.update_context("1.8")
    dist_18 = calc.get_modified_level_distribution(30, 22)
    results["1.8_gold30_stats"] = {
        "min": min(dist_18.keys()),
        "max": max(dist_18.keys()),
        "mean": sum(k * v for k, v in dist_18.items())
    }

    print("---MECHANICS_VERIFY_START---")
    print(json.dumps(results, indent=2))
    print("---MECHANICS_VERIFY_END---")

if __name__ == "__main__":
    verify_mechanics()
