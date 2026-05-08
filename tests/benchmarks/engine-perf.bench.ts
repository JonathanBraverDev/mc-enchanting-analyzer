import { performance } from 'node:perf_hooks';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';

async function runBenchmark() {
    console.log('--- Enchantment Engine Performance Benchmark ---');
    const engine = EngineFactory.create(DATA, '1.21');

    const scenarios = [
        { name: 'Diamond Sword @ Level 30', item: 'sword', xp: 30, material: 'diamond' },
        { name: 'Enchanted Book @ Level 30', item: 'book', xp: 30, material: 'book' },
        { name: 'Netherite Pickaxe @ Level 30', item: 'pickaxe', xp: 30, material: 'netherite' }
    ];

    for (const s of scenarios) {
        console.log(`\nScenario: ${s.name}`);

        // Warmup
        await engine.calculate({ item: s.item, xp: s.xp, material: s.material, threshold: 0.001 });
        engine.resetCaches();

        const iterations = 5;
        let totalMs = 0;

        for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            await engine.calculate({ item: s.item, xp: s.xp, material: s.material, threshold: 0.0001 });
            const end = performance.now();
            totalMs += (end - start);
            engine.resetCaches();
        }

        const avgMs = totalMs / iterations;
        console.log(`Average Execution Time (thr=0.0001): ${avgMs.toFixed(2)}ms`);
    }
}

runBenchmark().catch(console.error);
