import re

def parse_version(v):
    # Robustly handles 1.8.9, 1.21, and 25w41a by extracting numbers
    return [int(n) for n in re.findall(r'\d+', v)]

def is_valid_v(version, valid_from, valid_to="99.9"):
    try:
        curr = parse_version(version)
        start = parse_version(valid_from)
        end = parse_version(valid_to)
        
        # Compare lists (Python handles list comparison lexicographically)
        return start <= curr <= end
    except:
        return True

class Enchant:
    def __init__(self, name, weight, levels, conflicts=None, valid_from="1.0", valid_to="99.9"):
        self.name = name
        self.weight = weight
        self.levels = levels # Dict of rank -> [min, max]
        self.conflicts = conflicts or []
        self.valid_from = valid_from
        self.valid_to = valid_to

    def is_valid_for_version(self, version):
        return is_valid_v(version, self.valid_from, self.valid_to)

    def get_max_rank(self, modified_level):
        """Return the highest rank available for this modified level."""
        best_rank = None
        # Convert Roman numerals to ints for comparison or just use the sorted keys
        ranks = ["V", "IV", "III", "II", "I"]
        for r in ranks:
            if r in self.levels:
                r_min, r_max = self.levels[r]
                if r_min <= modified_level <= r_max:
                    return r
        return None
