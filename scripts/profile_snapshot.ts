import { EngineFactory } from '#engine/index.js';
import { DATA } from '../src/lib/data/index.js';
import { ENGINE_DEFAULTS } from '../src/lib/core/config.js';

async function profile() {
    const args = process.argv.slice(2);
    const findArg = (key: string) => {
        const idx = args.indexOf(key);
        return (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) ? args[idx + 1] : null;
    };
    const version = findArg('--version') ?? '1.21.11';
    
    console.log(`Profiling ${version} search performance...`);
    const engine = EngineFactory.create(DATA, version);
    const SNAPSHOT_LIMIT = ENGINE_DEFAULTS.MAX_RESULTS_UNBOUNDED;
    const SNAPSHOT_ITERATIONS = ENGINE_DEFAULTS.MAX_ITERATIONS_UNBOUNDED;
    const SNAPSHOT_THRESHOLD = 0.00000001;

    const timing = { totalMs: 0, searchMs: 0, filteringMs: 0, distributionMs: 0, settlingMs: 0, heapMs: 0 };
    console.time('TargetSnapshot');
    const stats = await engine.calculate(
        'book', 
        30, 
        'book', 
        { 
            threshold: SNAPSHOT_THRESHOLD, 
            maxIterations: SNAPSHOT_ITERATIONS, 
            summaryLimit: SNAPSHOT_LIMIT, 
            resultsLimit: SNAPSHOT_LIMIT, 
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
        console.log(`  - Settling:      ${t.settlingMs.toFixed(2)}ms`);
        console.log(`  - Filtering:     ${t.filteringMs.toFixed(2)}ms`);
        console.log(`  - Distribution:  ${t.distributionMs.toFixed(2)}ms`);
        console.log(`  - Heap:          ${t.heapMs.toFixed(2)}ms (inc. pop + pushes)`);
        console.log(`Total Wall Time (incl. orchestration): ${t.totalMs.toFixed(2)}ms`);
        
        // SearchMs includes everything in processSearchNode (filtering, distribution, settling, heap pushes)
        // HeapMs includes both pops in the main loop and pushes in processSearchNode.
        console.log(`Note: Heap operations represent the vast majority of the search time.`);
    } else {
        console.log('No timing metrics captured.');
    }
}

profile().catch(console.error);
