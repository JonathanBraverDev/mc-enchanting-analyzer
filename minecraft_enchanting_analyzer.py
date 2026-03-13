import os
import sys

# Optional dependencies
try:
    import pandas as pd
    PANDAS_AVAILABLE = True
except ImportError:
    PANDAS_AVAILABLE = False

try:
    import matplotlib.pyplot as plt
    MATPLOTLIB_AVAILABLE = True
except ImportError:
    MATPLOTLIB_AVAILABLE = False

# Local imports
from data_manager import DataManager
from calculator import EnchantCalculator

# -------------------------------------------------
# Distributions and Graphing
# -------------------------------------------------

def graph_primary_across_levels(calculator, category, version):
    if not MATPLOTLIB_AVAILABLE:
        print("Matplotlib not installed. Skipping graph generation.")
        return

    levels = list(range(1, 31))
    data = {}
    for L in levels:
        dist = calculator.primary_distribution(category, L, version)
        for ench in dist:
            data.setdefault(ench, [0]*30)
            data[ench][L-1] = dist.get(ench, 0)

    plt.figure(figsize=(10, 6))
    for ench, vals in data.items():
        plt.plot(levels, vals, label=ench)

    plt.xlabel("Enchant Level")
    plt.ylabel("Probability")
    plt.title(f"Primary Enchant Probability vs Level ({category}) - v{version}")
    plt.legend()
    plt.grid(True, alpha=0.3)
    plt.show()

# -------------------------------------------------
# Interactive CLI
# -------------------------------------------------

def main():
    print("==============================================")
    print("   Minecraft Enchanting Distribution Analyzer")
    print("==============================================")

    if not PANDAS_AVAILABLE or not MATPLOTLIB_AVAILABLE:
        print("\n[NOTE] Some visualization features are disabled due to missing dependencies.")
        print("To enable full features, run: pip install pandas matplotlib\n")

    manager = DataManager()
    if not manager.raw_data:
        return

    version = input("Minecraft version (e.g., 1.8, 1.20) [default 1.20]: ").strip() or "1.20"
    manager.update_context(version)
    
    calculator = EnchantCalculator(manager)

    while True:
        print("\n--- New Analysis ---")
        cats = sorted(manager.category_enchants.keys())
        category = input(f"Item category ({', '.join(cats)}) [or 'exit']: ").strip().lower()
        if category == 'exit':
            break
        
        if category not in manager.category_enchants:
            print("Invalid category.")
            continue

        mats = sorted(manager.available_materials.keys())
        material = input(f"Material ({', '.join(mats)}): ").strip().lower()
        if material not in manager.available_materials:
            print("Invalid material for this version.")
            continue
            
        mat_info = manager.available_materials[material]
        enchantability = mat_info["value"]

        try:
            level_input = input("Enchant level (1-30) [default 30]: ").strip()
            level = int(level_input) if level_input else 30
        except ValueError:
            print("Invalid level.")
            continue

        print(f"\nAnalyzing {material} {category} (Enchantability: {enchantability}) at level {level} (Version {version})...")

        # Primary distribution
        prim = calculator.primary_distribution(category, level, version, enchantability)
        if not prim:
            print("No valid enchantments found for these settings.")
            continue

        print("\nPrimary Distribution:")
        print("-" * 30)
        for k, v in sorted(prim.items(), key=lambda x: -x[1]):
            print(f"{k:20} {v:.3%}")

        # Combination distribution
        print("\nTop Combinations:")
        print("-" * 30)
        combos = calculator.combination_distribution(category, level, version, enchantability)
        
        if PANDAS_AVAILABLE:
            df = pd.DataFrame([
                (" + ".join(k), v) for k, v in combos.items()
            ], columns=["Enchant Combination", "Probability"])
            print(df.sort_values("Probability", ascending=False).head(10).to_string(index=False))
        else:
            sorted_combos = sorted(combos.items(), key=lambda x: -x[1])
            for combo, prob in sorted_combos[:10]:
                print(f"{' + '.join(combo):40} {prob:.3%}")

        # Graphing
        do_graph = input("\nGenerate level sweep graph (1-30)? (y/n): ").strip().lower()
        if do_graph == 'y':
            graph_primary_across_levels(calculator, category, version)

    print("\nGoodbye!")

if __name__ == "__main__":
    main()
