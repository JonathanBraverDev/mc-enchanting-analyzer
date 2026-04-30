import { EngineFactory } from '#engine/index.js';
import { DATA } from '#data/index.js';
import { TEST_DEFAULTS } from '#constants/testing.js';
import { ENGINE_LIMITS } from '#constants/engine.js';

async function profile() {
    const args = process.argv.slice(2);
    const findArg = (key: string) => {
        const idx = args.indexOf(key);
        const next = idx !== -1 ? args[idx + 1] : undefined;
        return (next && !next.startsWith('--')) ? next : null;
    };
    const version = findArg('--version') ?? '1.21.11';
    
    console.log(`Profiling ${version} search performance...`);
    const engine = EngineFactory.create(DATA, version);

    const timing = { totalMs: 0, searchMs: 0 };
    console.time('TargetSnapshot');
    const stats = await engine.calculate(
        'book',
        30,
        'book',
        {
            threshold: TEST_DEFAULTS.SNAPSHOT_THRESHOLD,
            maxIterations: ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED,
            summaryLimit: ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
            resultsLimit: ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
            useCache: false,
            timing
        }
    );
    console.timeEnd('TargetSnapshot');
    console.log('Results size:', Object.keys(stats.combos).length);
    console.log('--- Timing Breakdown ---');
    if (stats.timing) {
        const t = stats.timing;
        console.log(`Active Search Time: ${t.searchMs.toFixed(2)}ms`);
        console.log(`Total Wall Time (incl. orchestration): ${t.totalMs.toFixed(2)}ms`);
    } else {
        console.log('No timing metrics captured.');
    }
}

profile().catch(console.error);
