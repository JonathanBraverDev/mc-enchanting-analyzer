import math
import json
import os
from functools import lru_cache

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

# -------------------------------------------------
# Data Models and Loading
# -------------------------------------------------

class Enchant:
    def __init__(self, name, weight, min_level, max_level, conflicts=None, valid_from="1.0", valid_to="99.9"):
        self.name = name
        self.weight = weight
        self.min_level = min_level
        self.max_level = max_level
        self.conflicts = conflicts or []
        self.valid_from = valid_from
        self.valid_to = valid_to

    def is_valid_for_version(self, version):
        def parse_version(v):
            return [int(x) for x in v.split('.')]
        
        try:
            curr = parse_version(version)
            start = parse_version(self.valid_from)
            end = parse_version(self.valid_to)
            return start <= curr <= end
        except:
            return True

def load_data():
    data_path = "enchantments.json"
    if not os.path.exists(data_path):
        print(f"Error: {data_path} not found.")
        return {}, {}
    
    with open(data_path, 'r') as f:
        raw_data = json.load(f)
    
    enchantments = {}
    for cat, enchants in raw_data["enchantments"].items():
        enchantments[cat] = [Enchant(**e) for e in enchants]
    
    enchantability = raw_data["enchantability"]
    return enchantments, enchantability

# Global State
CATEGORY_ENCHANTS, ENCHANTABILITY = load_data()
ENCHANT_LOOKUP = {}

def update_lookup(version):
    global ENCHANT_LOOKUP
    ENCHANT_LOOKUP = {}
    for cat in CATEGORY_ENCHANTS:
        for e in CATEGORY_ENCHANTS[cat]:
            if e.is_valid_for_version(version):
                ENCHANT_LOOKUP[e.name] = e

# -------------------------------------------------
# Helper functions
# -------------------------------------------------

def valid_enchants(category, level, version):
    """Return enchants valid at this level and version."""
    enchants = CATEGORY_ENCHANTS.get(category, [])
    return [e for e in enchants if e.min_level <= level <= e.max_level and e.is_valid_for_version(version)]

def remove_conflicts(pool, chosen):
    new_pool = []
    for e in pool:
        if e.name == chosen.name:
            continue
        if e.name in chosen.conflicts:
            continue
        if chosen.name in e.conflicts:
            continue
        new_pool.append(e)
    return new_pool

# -------------------------------------------------
# Exact Probability Solver (Dynamic Programming)
# -------------------------------------------------

@lru_cache(None)
def solve_state(pool_names_tuple, level):
    pool = [ENCHANT_LOOKUP[n] for n in pool_names_tuple]
    results = {}
    total_weight = sum(e.weight for e in pool)
    if total_weight == 0: return {}

    for e in pool:
        p_primary = e.weight / total_weight
        remaining = remove_conflicts(pool, e)
        next_level = level // 2
        prob_continue = min((level + 1) / 50, 1)

        key = (e.name,)
        results[key] = results.get(key, 0) + p_primary * (1 - prob_continue)

        if remaining and prob_continue > 0:
            sub_pool = tuple(sorted(x.name for x in remaining))
            sub = solve_state(sub_pool, next_level)
            for combo, p in sub.items():
                new_combo = tuple([e.name] + list(combo))
                results[new_combo] = results.get(new_combo, 0) + p_primary * prob_continue * p

    return results

# -------------------------------------------------
# Distributions and Graphing
# -------------------------------------------------

def primary_distribution(category, level, version):
    pool = valid_enchants(category, level, version)
    total_weight = sum(e.weight for e in pool)
    if total_weight == 0: return {}
    return {e.name: e.weight / total_weight for e in pool}

def graph_primary_across_levels(category, version):
    if not MATPLOTLIB_AVAILABLE:
        print("Matplotlib not installed. Skipping graph generation.")
        return

    levels = list(range(1, 31))
    data = {}
    for L in levels:
        dist = primary_distribution(category, L, version)
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

def combination_distribution(category, level, version):
    pool = valid_enchants(category, level, version)
    names = tuple(sorted(e.name for e in pool))
    solve_state.cache_clear() # Clear cache for new calculation
    combos = solve_state(names, level)

    if PANDAS_AVAILABLE:
        df = pd.DataFrame([
            (" + ".join(k), v) for k, v in combos.items()
        ], columns=["Enchant Combination", "Probability"])
        return df.sort_values("Probability", ascending=False)
    else:
        sorted_combos = sorted(combos.items(), key=lambda x: -x[1])
        return sorted_combos

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

    version = input("Minecraft version (e.g., 1.8, 1.20) [default 1.20]: ").strip() or "1.20"
    update_lookup(version)

    while True:
        print("\n--- New Analysis ---")
        category = input("Item category (sword, pickaxe, boots, bow, book) [or 'exit']: ").strip().lower()
        if category == 'exit':
            break
        
        if category not in CATEGORY_ENCHANTS:
            print(f"Invalid category. Available: {', '.join(CATEGORY_ENCHANTS.keys())}")
            continue

        try:
            level_input = input("Enchant level (1-30) [default 30]: ").strip()
            level = int(level_input) if level_input else 30
        except ValueError:
            print("Invalid level. Please enter a number between 1 and 30.")
            continue

        print(f"\nAnalyzing {category} at level {level} (Version {version})...")

        # Primary distribution
        prim = primary_distribution(category, level, version)
        print("\nPrimary Distribution:")
        print("-" * 30)
        for k, v in sorted(prim.items(), key=lambda x: -x[1]):
            print(f"{k:20} {v:.3%}")

        # Combination distribution
        print("\nTop Combinations:")
        print("-" * 30)
        combos = combination_distribution(category, level, version)
        if PANDAS_AVAILABLE:
            print(combos.head(10).to_string(index=False))
        else:
            for combo, prob in combos[:10]:
                print(f"{' + '.join(combo):40} {prob:.3%}")

        # Graphing
        do_graph = input("\nGenerate level sweep graph (1-30)? (y/n): ").strip().lower()
        if do_graph == 'y':
            graph_primary_across_levels(category, version)

    print("\nGoodbye!")

if __name__ == "__main__":
    main()
