
import { DATA } from '../../src/data.js';
import { EnchantEngine } from '../../src/engine.js';
import { getParamsForMode, SearchLevel } from '../../src/config.js';

async function run() {
    const version = "1.21.11";
    const engine = new EnchantEngine(DATA, version);
    
    const cat = "book";
    const xp = 30;
    const mat = "diamond";

    const modes: Exclude<SearchLevel, 'done'>[] = ['coarse', 'standard', 'deep', 'ultra'];
    
    console.log(`Starting Precision Audit for ${cat} at level ${xp} (Version ${version})...`);
    console.log(`----------------------------------------------------------------------`);

    for (const level of modes) {
        const params = getParamsForMode(level, cat === "book");
        
        const start = Date.now();
        const stats = await engine.getFullStats(cat, xp, mat, null, params.threshold, undefined, undefined, false, params.limit);
        const duration = Date.now() - start;

        console.log(`Mode: ${level.toUpperCase()} - Limit: ${params.limit.toLocaleString()} (Threshold: ${params.threshold})`);
        console.log(`  Uncertainty: ${(stats.uncertainty * 100).toFixed(4)}%`);
        console.log(`  Confidence: ${(100 - stats.uncertainty * 100).toFixed(4)}%`);
        console.log(`  Time: ${duration}ms`);
        console.log(`----------------------------------------------------------------------`);
    }
}

run().catch(console.error);
