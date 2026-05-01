import { EngineFactory } from '#engine/index.js';
import { DATA as data } from '#data/index.js';
import { EngineInstrumentation } from '#types/index.js';


async function run() {
    const args = process.argv.slice(2);
    const findArg = (key: string) => {
        const idx = args.indexOf(key);
        return (idx !== -1 && args[idx + 1]) ? args[idx + 1] : null;
    };

    const cat = findArg('--cat') ?? 'book';
    const mat = findArg('--mat') ?? 'book';
    const xp = parseInt(findArg('--xp') ?? '30');
    const version = findArg('--version') ?? '1.21.11';

    console.log(`--- Running Enchantment Simulation ---`);
    console.log(`Version: ${version}, Category: ${cat}, Material: ${mat}, XP: ${xp}\n`);

    const engine = EngineFactory.create(data, version);
    const instrumentation: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false
    };

    console.log(`--- Running Enchantment Simulation ---`);
    console.log(`Version: ${version}, Category: ${cat}, Material: ${mat}, XP: ${xp}\n`);

    const threshold = 0.001; // 1e-3 Standard UI Fine Accuracy
    const start = performance.now();
    const stats = await engine.calculate({
        cat,
        xp,
        mat,
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

    console.log(`\nFinal Stats Summary:`);
    console.log(`  Exit Reason:    ${instrumentation.exitReason}`);
    console.log(`  Pruned Nodes:   ${instrumentation.totalPrunedNodes}`);
    console.log(`  Rounding Errors: ${instrumentation.roundingErrorEvents}`);
    console.log(`  Uncertainty:    ${(stats.accounting.pending * 100).toFixed(6)}%`);
    console.log(`  Rounding Mass:  ${stats.accounting.rounding.toExponential(4)}`);
}

run().catch(console.error);
