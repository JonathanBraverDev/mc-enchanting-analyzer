import { EngineFactory } from '#engine/index.js';
import { TEST_DEFAULTS } from '#constants/testing.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { EngineTestUtils } from '#tests/infra/test-utils.js';

interface PerfCase {
    name: string;
    version: string;
    item: string;
    material: string;
    xp: number;
    clue?: string;
}

const CASES: PerfCase[] = [
    {
        name: 'book-modern-no-clue',
        version: '1.21.11',
        item: 'book',
        material: 'book',
        xp: 30
    },
    {
        name: 'book-modern-common-clue',
        version: '1.21.11',
        item: 'book',
        material: 'book',
        xp: 30,
        clue: 'Protection III'
    },
    {
        name: 'book-modern-rare-clue',
        version: '1.21.11',
        item: 'book',
        material: 'book',
        xp: 30,
        clue: 'Projectile Protection IV'
    }
];

async function runCase(testCase: PerfCase) {
    const engine = EngineFactory.createForVersion(testCase.version);
    engine.resetCaches();

    const timing = { totalMs: 0, searchMs: 0, postProcessingMs: 0 };
    const wallStart = performance.now();
    const stats = await EngineTestUtils.getStats(engine, {
        item: testCase.item,
        xp: testCase.xp,
        material: testCase.material,
        clue: testCase.clue,
        threshold: TEST_DEFAULTS.SNAPSHOT_THRESHOLD,
        maxIterations: ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED,
        summaryLimit: ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
        resultsLimit: ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
        useCache: false,
        timing
    });
    const wallMs = performance.now() - wallStart;

    const searchMs = stats.timing?.searchMs ?? timing.searchMs;
    const postProcessingMs = stats.timing?.postProcessingMs ?? timing.postProcessingMs;
    const engineTotalMs = stats.timing?.totalMs ?? timing.totalMs;

    return {
        name: testCase.name,
        clue: testCase.clue ?? '',
        wallMs,
        searchMs,
        postProcessingMs,
        engineTotalMs,
        outsideEngineMs: wallMs - engineTotalMs,
        searchOverheadMs: engineTotalMs - searchMs - postProcessingMs,
        combos: Object.keys(stats.combos).length,
        accuracy: stats.accuracy,
        clueKnownSpace: stats.clue?.knownSpace
    };
}

function getRequestedCases(): PerfCase[] {
    const args = process.argv.slice(2);
    const caseIdx = args.indexOf('--case');
    const caseName = caseIdx === -1 ? null : args[caseIdx + 1];

    if (!caseName) return CASES;

    const selected = CASES.find(testCase => testCase.name === caseName);
    if (!selected) {
        throw new Error(`Unknown perf case "${caseName}". Available cases: ${CASES.map(testCase => testCase.name).join(', ')}`);
    }

    return [selected];
}

async function main() {
    const rows = [];

    for (const testCase of getRequestedCases()) {
        console.log(`Running ${testCase.name}${testCase.clue ? ` (${testCase.clue})` : ''}...`);
        rows.push(await runCase(testCase));
    }

    console.log('\nPerf cases:');
    console.table(rows.map(row => ({
        name: row.name,
        clue: row.clue,
        wallMs: row.wallMs.toFixed(2),
        searchMs: row.searchMs.toFixed(2),
        postProcessingMs: row.postProcessingMs.toFixed(2),
        engineTotalMs: row.engineTotalMs.toFixed(2),
        searchOverheadMs: row.searchOverheadMs.toFixed(2),
        outsideEngineMs: row.outsideEngineMs.toFixed(2),
        combos: row.combos,
        accuracy: row.accuracy.toFixed(12),
        clueKnownSpace: row.clueKnownSpace?.toFixed(12)
    })));

    console.log(JSON.stringify(rows, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
