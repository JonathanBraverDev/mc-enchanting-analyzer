import { EngineFactory } from '#engine/index.js';
import { DATA } from '../src/lib/data/index.js';

async function runProfile() {
    console.log('--- Enchantment Engine Performance Profile ---');

    const version = '1.21';
    const engine = EngineFactory.create(DATA, version);
    
    const categories = ['helmet', 'sword', 'book'];
    const materials = ['netherite', 'diamond'];
    const levels = [30];

    const level = levels[0];
    if (level === undefined) throw new Error('No levels configured');

    // Warm up
    console.log('Warming up...');
    for (const cat of categories) {
        for (const mat of materials) {
            await engine.calculate(cat, level, mat);
        }
    }

    engine.resetCaches();
    console.log('\nRunning Benchmarks (Cold Cache)...');

    const start = performance.now();
    for (const cat of categories) {
        for (const mat of materials) {
            const qStart = performance.now();
            await engine.calculate(cat, level, mat);
            console.log(`[Cold] ${cat} @ ${level} (${mat}): ${(performance.now() - qStart).toFixed(2)}ms`);
        }
    }
    const coldDuration = performance.now() - start;

    console.log('\nRunning Benchmarks (Warm Cache)...');
    const startWarm = performance.now();
    for (const cat of categories) {
        for (const mat of materials) {
            const qStart = performance.now();
            await engine.calculate(cat, level, mat);
            console.log(`[Warm] ${cat} @ ${level} (${mat}): ${(performance.now() - qStart).toFixed(2)}ms`);
        }
    }
    const warmDuration = performance.now() - startWarm;

    console.log('\n--- Results ---');
    console.log(`Total Cold: ${coldDuration.toFixed(2)}ms`);
    console.log(`Total Warm: ${warmDuration.toFixed(2)}ms`);
    console.log(`Speedup: ${(coldDuration / warmDuration).toFixed(2)}x`);

    const metrics = engine.getCacheMetrics();
    console.log('\n--- Cache Metrics ---');
    console.log(JSON.stringify(metrics, null, 2));
}

runProfile().catch(console.error);
