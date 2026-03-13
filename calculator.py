from functools import lru_cache

class EnchantCalculator:
    def __init__(self, data_manager):
        self.data_manager = data_manager

    def get_modified_level_distribution(self, xp_level, enchantability):
        """Return {modified_level: probability} for the given inputs."""
        if enchantability <= 0:
            return {xp_level: 1.0}
            
        div = self.data_manager.mechanics.get("enchantability_bonus_divisor", 4)
        rng = self.data_manager.mechanics.get("random_bonus_range", 0.15)
        
        N = enchantability // div + 1
        base_dist = {}
        for r1 in range(N):
            for r2 in range(N):
                val = xp_level + r1 + r2 + 1
                base_dist[val] = base_dist.get(val, 0) + 1.0 / (N*N)
                
        final_dist = {}
        # Sample the bonus (randFloat() + randFloat() - 1) * rng
        steps = 41 # Higher precision
        for base_val, base_prob in base_dist.items():
            for i in range(steps):
                for j in range(steps):
                    bonus = (i/(steps-1) * rng) + (j/(steps-1) * rng) - rng
                    # Java Math.round: floor(x + 0.5)
                    mod_val = int(base_val * (1 + bonus) + 0.5)
                    mod_val = max(1, mod_val)
                    p = base_prob / (steps * steps)
                    final_dist[mod_val] = final_dist.get(mod_val, 0) + p
        
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

    def solve_state_internal(self, pool_all_possible, mod_level, category, xp_level, version):
        # pool_all_possible is a function or list that returns eligible enchants at a given mod_level
        lookup = self.data_manager.enchant_lookup
        
        @lru_cache(None)
        def _solve(names_with_ranks_tuple, current_mod_lvl):
            # names_with_ranks_tuple represents already chosen enchantments to avoid duplicates/conflicts
            # current_mod_lvl is the level used for the 'continue' check and pool filtering
            
            # 1. Fetch pool for current mod level
            pool_ranked = self.valid_enchants_at_mod_level(category, current_mod_lvl, version)
            
            # 2. Filter out conflicts and already chosen
            chosen_names = {n for n, r in names_with_ranks_tuple}
            eligible = []
            for p in pool_ranked:
                if p["enchant"].name in chosen_names: continue
                # Check conflicts with all chosen
                conflict = False
                for c_name, c_rank in names_with_ranks_tuple:
                    if c_name in p["enchant"].conflicts or p["enchant"].name in lookup[c_name].conflicts:
                        conflict = True
                        break
                if not conflict:
                    eligible.append(p)
            
            if not eligible: return {}

            results = {}
            total_weight = sum(p["enchant"].weight for p in eligible)
            
            for p in eligible:
                p_primary = p["enchant"].weight / total_weight
                name_rank = f"{p['enchant'].name} {p['rank']}"
                
                # Probability to continue
                # MCP 1.6.2: while (random.nextInt(50) <= l) { ... l /= 2; }
                # This means the check happens with the current level, THEN it's halved for the NEXT pick.
                prob_continue = min((current_mod_lvl + 1) / 50, 1.0)
                
                # Restriction for books
                if category == "book" and not self.data_manager.multi_enchant_books:
                    prob_continue = 0

                # Option A: Stop here
                combo_base = (name_rank,)
                results[combo_base] = results.get(combo_base, 0) + p_primary * (1 - prob_continue)

                # Option B: Continue
                if prob_continue > 0:
                    next_mod_lvl = current_mod_lvl // 2
                    sub_pool = tuple(sorted(list(names_with_ranks_tuple) + [(p["enchant"].name, p["rank"])]))
                    sub = _solve(sub_pool, next_mod_lvl)
                    for combo, prob in sub.items():
                        # The sub-result already includes the primary pick in names_with_ranks_tuple? 
                        # No, wait. Let's adjust recursion.
                        pass # See below for better structure
            return results

        # Actually, let's use a more robust recursive structure
        @lru_cache(None)
        def _get_dist(chosen_tuple, curr_mod_lvl):
            # chosen_tuple: (("Sharpness", "III"), ...)
            pool = self.valid_enchants_at_mod_level(category, curr_mod_lvl, version)
            chosen_names = {n for n, r in chosen_tuple}
            
            eligible = []
            for p in pool:
                if p["enchant"].name in chosen_names: continue
                conflict = False
                for c_name, _ in chosen_tuple:
                    if c_name in p["enchant"].conflicts or p["enchant"].name in lookup[c_name].conflicts:
                        conflict = True
                        break
                if not conflict:
                    eligible.append(p)
            
            if not eligible:
                return {tuple(sorted([f"{n} {r}" for n, r in chosen_tuple])): 1.0}
            
            total_weight = sum(p["enchant"].weight for p in eligible)
            results = {}
            
            prob_continue = min((curr_mod_lvl + 1) / 50, 1.0)
            if category == "book" and not self.data_manager.multi_enchant_books:
                prob_continue = 0
            
            if not chosen_tuple:
                # Must pick at least one
                for p in eligible:
                    p_weight = p["enchant"].weight / total_weight
                    sub = _get_dist(((p["enchant"].name, p["rank"]),), curr_mod_lvl)
                    for combo, prob in sub.items():
                        results[combo] = results.get(combo, 0) + p_weight * prob
            else:
                # Probability to stop
                results[tuple(sorted([f"{n} {r}" for n, r in chosen_tuple]))] = 1 - prob_continue
                
                # Probability to pick another
                if prob_continue > 0:
                    next_mod_lvl = curr_mod_lvl // 2
                    for p in eligible:
                        p_weight = (p["enchant"].weight / total_weight) * prob_continue
                        sub = _get_dist(tuple(sorted(list(chosen_tuple) + [(p["enchant"].name, p["rank"])])), next_mod_lvl)
                        for combo, prob in sub.items():
                            results[combo] = results.get(combo, 0) + p_weight * prob
            return results

        return _get_dist((), mod_level)

    def combination_distribution(self, category, xp_level, version, enchantability):
        mod_dist = self.get_modified_level_distribution(xp_level, enchantability)
        total_combos = {}
        
        for mod_level, mod_prob in mod_dist.items():
            combos = self.solve_state_internal(None, mod_level, category, xp_level, version)
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

    def aggregate_distribution(self, category, xp_level, version, enchantability):
        """Returns complex stats: specific ranks, 'Any X', and '# Enchants'."""
        combos = self.combination_distribution(category, xp_level, version, enchantability)
        
        stats = {
            "ranks": {}, # "Sharpness I": 0.5
            "any": {},   # "Any Sharpness": 0.7
            "count": {}  # "1 Enchant": 0.8
        }
        
        for combo, prob in combos.items():
            # Count
            cnt = len(combo)
            stats["count"][cnt] = stats["count"].get(cnt, 0) + prob
            
            # Any and Ranks
            seen_bases = set()
            for entry in combo:
                # entry is "Sharpness III"
                parts = entry.rsplit(' ', 1)
                base = parts[0]
                stats["ranks"][entry] = stats["ranks"].get(entry, 0) + prob
                if base not in seen_bases:
                    stats["any"][base] = stats["any"].get(base, 0) + prob
                    seen_bases.add(base)
                    
        return stats
