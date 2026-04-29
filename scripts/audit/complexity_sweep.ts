
import { DATA } from '../../src/data.js';
import { EnchantEngine } from '../../src/engine.js';
import { getParamsForMode } from '../../src/config.js';
import * as fs from 'fs';

async function run() {
    const version = "1.21.11";
    const engine = new EnchantEngine(DATA, version);
    const registry = engine.registry;

    const allCats = Object.keys(registry.mergedItems);
    const csvLines = ["Category,Enchantability,Level,CoarseUncertainty,StandardUncertainty"];

    console.log(`Auditing ${allCats.length} categories for version ${version}...`);

    for (const cat of allCats) {
        const eligibleMats = registry.getEligibleMaterials(cat);
        const uniqueEnchantabilities = new Set<number>();
        
        for (const mat of eligibleMats) {
            uniqueEnchantabilities.add(registry.getEnchantability(mat, cat));
        }

        for (const ench of Array.from(uniqueEnchantabilities).sort((a,b) => a-b)) {
            // Test levels 1, 15, and 30 for speed
            for (const lvl of [1, 15, 30]) {
                const cParams = getParamsForMode('coarse', cat === "book");
                const sParams = getParamsForMode('standard', cat === "book");
                
                const coarse = await engine.getFullStats(cat, lvl, "iron", null, cParams.threshold, undefined, undefined, false, cParams.limit);
                const standard = await engine.getFullStats(cat, lvl, "iron", null, sParams.threshold, undefined, undefined, false, sParams.limit);
                
                csvLines.push(`${cat},${ench},${lvl},${coarse.uncertainty},${standard.uncertainty}`);
            }
        }
    }

    const outPath = 'audit_complexity_results.csv';
    fs.writeFileSync(outPath, csvLines.join('\n'));
    console.log(`Sweep complete. Results saved to ${outPath}`);
}

run().catch(console.error);
