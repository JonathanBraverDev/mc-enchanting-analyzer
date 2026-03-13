from flask import Flask, request, jsonify
from flask_cors import CORS
import os

from data_manager import DataManager
from calculator import EnchantCalculator

app = Flask(__name__)
CORS(app) # Enable CORS for React frontend

manager = DataManager()

@app.route('/api/versions', methods=['GET'])
def get_versions():
    # Return available versions from enchantments.json
    versions = sorted(manager.raw_data.get("versions", {}).keys())
    return jsonify(versions)

@app.route('/api/options', methods=['GET'])
def get_options():
    version = request.args.get('version', '1.20')
    manager.update_context(version)
    
    return jsonify({
        "categories": sorted(manager.category_enchants.keys()),
        "materials": sorted(manager.available_materials.keys())
    })

@app.route('/api/analyze', methods=['GET'])
def analyze():
    version = request.args.get('version', '1.20')
    category = request.args.get('category')
    material = request.args.get('material')
    level = int(request.args.get('level', 30))
    
    if not category or not material:
        return jsonify({"error": "Missing parameters"}), 400
        
    manager.update_context(version)
    calculator = EnchantCalculator(manager)
    enchantability = manager.get_material_value(material, category)
    
    stats = calculator.aggregate_distribution(category, level, version, enchantability)
    
    return jsonify({
        "stats": stats,
        "enchantability": enchantability
    })

@app.route('/api/sweep', methods=['GET'])
def sweep():
    version = request.args.get('version', '1.20')
    category = request.args.get('category')
    material = request.args.get('material')
    
    if not category or not material:
        return jsonify({"error": "Missing parameters"}), 400
        
    manager.update_context(version)
    calculator = EnchantCalculator(manager)
    enchantability = manager.get_material_value(material, category)
    
    levels = list(range(1, 31))
    sweep_data = []
    
    for L in levels:
        stats = calculator.aggregate_distribution(category, L, version, enchantability)
        sweep_data.append({
            "level": L,
            "stats": stats
        })
        
    return jsonify({
        "sweep": sweep_data,
        "enchantability": enchantability
    })

if __name__ == '__main__':
    app.run(debug=True, port=5000)
