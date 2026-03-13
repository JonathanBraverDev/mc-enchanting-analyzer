import json
import os
from models import Enchant, parse_version

def load_data():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_path = os.path.join(script_dir, "enchantments.json")
    if not os.path.exists(data_path):
        print(f"Error: {data_path} not found.")
        return {}
    
    with open(data_path, 'r') as f:
        return json.load(f)

def get_version_chain(target_version, version_data):
    chain = []
    curr = target_version
    
    if curr not in version_data:
        sorted_versions = sorted(version_data.keys(), key=parse_version)
        found = None
        for v in sorted_versions:
            if parse_version(v) <= parse_version(target_version):
                found = v
            else:
                break
        curr = found

    while curr:
        chain.insert(0, curr)
        curr = version_data[curr].get("extends")
    return chain

class DataManager:
    def __init__(self):
        self.raw_data = load_data()
        self.enchant_lookup = {}
        self.available_materials = {}
        self.category_enchants = {}
        self.active_version = None
        self.multi_enchant_books = True

    def update_context(self, version):
        self.active_version = version
        version_data = self.raw_data.get("versions", {})
        global_registry = self.raw_data.get("global_enchantments", {})
        groups = self.raw_data.get("enchantment_groups", {})
        material_values = self.raw_data.get("material_values", {})
        
        chain = get_version_chain(version, version_data)
        
        merged_items = {}
        merged_materials = []
        merged_overrides = {}
        self.multi_enchant_books = True # Default
        
        for v_name in chain:
            v_manifest = version_data[v_name]
            
            for cat, content in v_manifest.get("item_enchantments", {}).items():
                resolved_names = []
                for item in content:
                    if item in groups:
                        resolved_names.extend(groups[item])
                    else:
                        resolved_names.append(item)
                merged_items[cat] = sorted(list(set(resolved_names)))
                
            if "materials" in v_manifest:
                merged_materials.extend(v_manifest["materials"])
            elif not merged_materials and v_name == chain[0]:
                merged_materials = ["iron", "diamond"]
                
            for ench_name, props in v_manifest.get("overrides", {}).items():
                if ench_name not in merged_overrides:
                    merged_overrides[ench_name] = {}
                merged_overrides[ench_name].update(props)
            
            if "multi_enchant_books" in v_manifest:
                self.multi_enchant_books = v_manifest["multi_enchant_books"]

        self.enchant_lookup = {}
        self.category_enchants = {}
        
        for cat, names in merged_items.items():
            cat_enchants = []
            for name in names:
                if name in global_registry:
                    final_props = global_registry[name].copy()
                    final_props.update(merged_overrides.get(name, {}))
                    
                    # Levels are now in the properties
                    e = Enchant(name=name, **final_props)
                    self.enchant_lookup[name] = e
                    cat_enchants.append(e)
            self.category_enchants[cat] = cat_enchants
            
        # Distinguish between tool and armor materials
        self.available_materials = {}
        for mat in merged_materials:
            # Check both tables
            if mat in material_values.get("tools", {}):
                self.available_materials[mat] = {"type": "tools", "value": material_values["tools"][mat]}
            elif mat in material_values.get("armor", {}):
                self.available_materials[mat] = {"type": "armor", "value": material_values["armor"][mat]}
            else:
                self.available_materials[mat] = {"type": "tools", "value": 10} # Fallback
