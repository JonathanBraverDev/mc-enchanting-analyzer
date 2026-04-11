import { EnchantEngine } from '../src/engine/index.js';
import { DATA as data } from '../src/data/index.js';
import { EngineInstrumentation } from '../src/types/index.js';

async function run() {
    const version = '1.21.11';
    const cat = 'book';
    const mat = 'book';
    const xp = 30;

    const engine = new EnchantEngine(data, version);
    const instrumentation: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, checkpointSummary: [], levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false,
        checkpoints: []
    };

    console.log(`--- Running Enchantment Simulation ---`);
    console.log(`Version: ${version}, Category: ${cat}, Material: ${mat}, XP: ${xp}\n`);

    const threshold = 0.001; // 1e-3 Standard UI Fine Accuracy
    const start = performance.now();
    const stats = await engine.getFullStats(cat, xp, mat, { 
        instrumentation, 
        threshold,
        maxIterations: 100000, // High limit for snapshot level
        resultsLimit: 1000 
    });
    const end = performance.now();

    console.log(`Caches:`);
    console.log(`  Pool:     ${instrumentation.poolCache.hits} hits, ${instrumentation.poolCache.misses} misses`);
    console.log(`  Dist:     ${instrumentation.distCache.hits} hits, ${instrumentation.distCache.misses} misses`);
    console.log(`  Frontier: ${instrumentation.frontierCache.hits} hits, ${instrumentation.frontierCache.misses} misses`);
    console.log(`\nSearch Performance:`);
    console.log(`  Total Iterations: ${instrumentation.totalIterations}`);
    console.log(`  Execution Time:   ${(end - start).toFixed(2)}ms`);

    console.log(`\nMass Checkpoints (Threshold vs Accuracy):`);
    console.table(instrumentation.checkpoints.map(cp => ({
        'Mass %': (cp.mass * 100).toFixed(2) + '%',
        'Threshold (next.prob)': cp.threshold.toExponential(4),
        'It (Local)': cp.iterations,
        'It (Global)': cp.totalIterations
    })));

    console.log(`\nFinal Stats Summary:`);
    console.log(`  Exit Reason:    ${instrumentation.exitReason}`);
    console.log(`  Pruned Nodes:   ${instrumentation.totalPrunedNodes}`);
    console.log(`  Rounding Errors: ${instrumentation.roundingErrorEvents}`);
    console.log(`  Uncertainty:    ${(stats.uncertainty * 100).toFixed(6)}%`);
    console.log(`  Rounding Error: ${stats.roundingError}`);
}

run().catch(console.error);
