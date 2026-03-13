def parse_version(v):
    return [int(x) for x in v.split('.')]

def is_valid_v(version, valid_from, valid_to="99.9"):
    try:
        curr = parse_version(version)
        start = parse_version(valid_from)
        end = parse_version(valid_to)
        return start <= curr <= end
    except:
        return True

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
        return is_valid_v(version, self.valid_from, self.valid_to)
