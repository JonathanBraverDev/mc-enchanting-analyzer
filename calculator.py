from functools import lru_cache

class EnchantCalculator:
    def __init__(self, data_manager):
        self.data_manager = data_manager

    def valid_enchants(self, category, level, version):
        enchants = self.data_manager.category_enchants.get(category, [])
        return [e for e in enchants if e.min_level <= level <= e.max_level and e.is_valid_for_version(version)]

    def remove_conflicts(self, pool, chosen):
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

    def solve_state_internal(self, pool_names_tuple, level):
        # We need a way to access ENCHANT_LOOKUP here. 
        # Since lru_cache doesn't support 'self' easily in the key, 
        # we'll use a local cache or pass context.
        # However, for simplicity in this refactor, we'll keep the cache global-ish 
        # but scoped to this method call if needed, or just use the manager's lookup.
        
        lookup = self.data_manager.enchant_lookup
        
        @lru_cache(None)
        def _solve(names, L):
            pool = [lookup[n] for n in names]
            results = {}
            total_weight = sum(e.weight for e in pool)
            if total_weight == 0: return {}

            for e in pool:
                p_primary = e.weight / total_weight
                remaining = self.remove_conflicts(pool, e)
                next_level = L // 2
                prob_continue = min((L + 1) / 50, 1)

                key = (e.name,)
                results[key] = results.get(key, 0) + p_primary * (1 - prob_continue)

                if remaining and prob_continue > 0:
                    sub_pool = tuple(sorted(x.name for x in remaining))
                    sub = _solve(sub_pool, next_level)
                    for combo, p in sub.items():
                        new_combo = tuple([e.name] + list(combo))
                        results[new_combo] = results.get(new_combo, 0) + p_primary * prob_continue * p

            return results
        
        return _solve(pool_names_tuple, level)

    def primary_distribution(self, category, level, version):
        pool = self.valid_enchants(category, level, version)
        total_weight = sum(e.weight for e in pool)
        if total_weight == 0: return {}
        return {e.name: e.weight / total_weight for e in pool}

    def combination_distribution(self, category, level, version):
        pool = self.valid_enchants(category, level, version)
        names = tuple(sorted(e.name for e in pool))
        combos = self.solve_state_internal(names, level)
        return combos
