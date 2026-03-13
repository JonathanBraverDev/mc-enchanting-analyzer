from functools import lru_cache

class EnchantCalculator:
    def __init__(self, data_manager):
        self.data_manager = data_manager

    def get_modified_level_distribution(self, xp_level, enchantability):
        """Return {modified_level: probability} for the given inputs."""
        if enchantability <= 0:
            return {xp_level: 1.0}
            
        # 1. base = xp_level + rand(0, e/4 + 1) + rand(0, e/4 + 1) + 1
        # Sum of two independent uniform distributions [0, N]
        N = enchantability // 4 + 1
        base_dist = {}
        for r1 in range(N):
            for r2 in range(N):
                val = xp_level + r1 + r2 + 1
                base_dist[val] = base_dist.get(val, 0) + 1.0 / (N*N)
                
        # 2. modified = round(base * (1 + (rand() + rand() - 1) * 0.15))
        # rand() + rand() - 1 is a triangular distribution [-1, 1]
        # For simplicity in discrete simulation, we can sample the triangular 
        # or use a reasonably granular step. Let's use 21 steps for the triangle.
        tri_dist = {}
        steps = 20
        total_steps = 0
        for i in range(-steps, steps + 1):
            # weight = steps - abs(i)
            # triangular weight: 1 - |x|
            w = (steps - abs(i)) / float(steps * steps)
            if i == 0: w = 1.0 / steps # Adjusting for center
            # Actually simpler: sum of two uniform [-0.5, 0.5]
            # Let's just use a representative sample of 100 points for the triangle
            pass

        # Re-calc: (rand() + rand() - 1) * 0.15 is the bonus factor
        # bonus = 1 + factor
        final_dist = {}
        samples = 10
        for base_val, base_prob in base_dist.items():
            for i in range(samples):
                for j in range(samples):
                    # sum of two uniform [0, 0.15] - 0.15
                    factor = (i/samples * 0.15) + (j/samples * 0.15) - 0.15
                    mod_val = round(base_val * (1 + factor))
                    mod_val = max(1, mod_val)
                    final_dist[mod_val] = final_dist.get(mod_val, 0) + (base_prob / (samples * samples))
        
        return final_dist

    def valid_enchants_at_mod_level(self, category, mod_level, version):
        """Find highest eligible rank for each enchantment at this mod_level."""
        enchants = self.data_manager.category_enchants.get(category, [])
        pool = []
        for e in enchants:
            if e.is_valid_for_version(version):
                rank = e.get_max_rank(mod_level)
                if rank:
                    # We create a temporary "RankedEnchant" or just store the name
                    pool.append({"enchant": e, "rank": rank})
        return pool

    def solve_state_internal(self, pool_ranked, level, category):
        # pool_ranked is list of {"enchant": e, "rank": r}
        lookup = self.data_manager.enchant_lookup
        
        @lru_cache(None)
        def _solve(names_with_ranks_tuple, L):
            # names_with_ranks_tuple is e.g. (("Sharpness", "III"), ("Unbreaking", "II"))
            pool_data = []
            for name, rank in names_with_ranks_tuple:
                base_e = lookup[name]
                pool_data.append({"name": name, "rank": rank, "weight": base_e.weight, "conflicts": base_e.conflicts})
            
            results = {}
            total_weight = sum(p["weight"] for p in pool_data)
            if total_weight == 0: return {}

            for p in pool_data:
                p_primary = p["weight"] / total_weight
                # Conflicts
                remaining = []
                for other in pool_data:
                    if other["name"] == p["name"]: continue
                    if other["name"] in p["conflicts"]: continue
                    if p["name"] in other["conflicts"]: continue
                    remaining.append((other["name"], other["rank"]))
                
                next_level = L // 2
                prob_continue = min((L + 1) / 50, 1)
                
                # Historical restriction: Books before 1.7.2
                if category == "book" and not self.data_manager.multi_enchant_books:
                    prob_continue = 0

                key = (f"{p['name']} {p['rank']}",)
                results[key] = results.get(key, 0) + p_primary * (1 - prob_continue)

                if remaining and prob_continue > 0:
                    sub_pool = tuple(sorted(remaining))
                    sub = _solve(sub_pool, next_level)
                    for combo, prob in sub.items():
                        new_combo = tuple([f"{p['name']} {p['rank']}"] + list(combo))
                        results[new_combo] = results.get(new_combo, 0) + p_primary * prob_continue * prob
            return results
        
        pool_tuple = tuple(sorted((p["enchant"].name, p["rank"]) for p in pool_ranked))
        return _solve(pool_tuple, level)

    def combination_distribution(self, category, xp_level, version, enchantability):
        mod_dist = self.get_modified_level_distribution(xp_level, enchantability)
        total_combos = {}
        
        for mod_level, mod_prob in mod_dist.items():
            pool_ranked = self.valid_enchants_at_mod_level(category, mod_level, version)
            if not pool_ranked: continue
            
            combos = self.solve_state_internal(pool_ranked, xp_level, category)
            for combo, p in combos.items():
                total_combos[combo] = total_combos.get(combo, 0) + p * mod_prob
        
        return total_combos

    def primary_distribution(self, category, xp_level, version, enchantability):
        mod_dist = self.get_modified_level_distribution(xp_level, enchantability)
        total_prim = {}
        
        for mod_level, mod_prob in mod_dist.items():
            pool_ranked = self.valid_enchants_at_mod_level(category, mod_level, version)
            if not pool_ranked: continue
            
            t_weight = sum(p["enchant"].weight for p in pool_ranked)
            for p in pool_ranked:
                name_rank = f"{p['enchant'].name} {p['rank']}"
                p_val = (p['enchant'].weight / t_weight) * mod_prob
                total_prim[name_rank] = total_prim.get(name_rank, 0) + p_val
                
        return total_prim
