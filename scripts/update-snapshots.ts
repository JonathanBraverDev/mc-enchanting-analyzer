import { EnchantEngine, EngineFactory } from '#engine/index.js';
import { SnapshotUtils } from '#tests/infra/test-utils.js';
import { TEST_DEFAULTS } from '#constants/testing.js';
import type { EnchantStats, EngineInstrumentation } from '#types/index.js';

interface SnapshotCase {
    name: string;
    version: string;
    item: string;
    xp: number;
    material: string;
    clue?: string;
    targetClassifiedMass?: number;
    maxIterations?: number;
    expensive?: boolean;
}

const SNAPSHOT_CASES: SnapshotCase[] = [
    { name: '1.8_sword_30_diamond', version: '1.8', item: 'sword', xp: 30, material: 'diamond' },
    { name: '1.21_mace_30_mace', version: '1.21', item: 'mace', xp: 30, material: 'mace' },
    { name: '1.21.11_spear_30_diamond', version: '1.21.11', item: 'spear', xp: 30, material: 'diamond' },
    { name: '1.21_sword_30_diamond_clue_sharpness', version: '1.21', item: 'sword', xp: 30, material: 'diamond', clue: 'Sharpness IV' },
    { name: '1.8_bow_30_bow_clue_power', version: '1.8', item: 'bow', xp: 30, material: 'bow', clue: 'Power IV' },
    { name: '1.4.6_book_30_book', version: '1.4.6', item: 'book', xp: 30, material: 'book' },
    { name: '1.7.2_book_30_book', version: '1.7.2', item: 'book', xp: 30, material: 'book' },
    { name: '1.14_chestplate_30_diamond', version: '1.14', item: 'chestplate', xp: 30, material: 'diamond' },
    { name: '1.14.3_chestplate_30_diamond', version: '1.14.3', item: 'chestplate', xp: 30, material: 'diamond' },
    {
        name: '1.21.11_book_30_book',
        version: '1.21.11',
        item: 'book',
        xp: 30,
        material: 'book',
        targetClassifiedMass: TEST_DEFAULTS.MODERN_BOOK_SNAPSHOT_TARGET_CLASSIFIED_MASS,
        maxIterations: TEST_DEFAULTS.MODERN_BOOK_SNAPSHOT_ITERATIONS
    }
];

function createSnapshotInstrumentation(): EngineInstrumentation {
    return {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        totalIterations: 0,
        totalPrunedNodes: 0,
        roundingErrorEvents: 0,
        levelsProcessed: 0,
        levelsFullyResolved: 0,
        fullyResolved: false
    };
}

function getRequestedCases(): SnapshotCase[] {
    const args = process.argv.slice(2);
    const caseIdx = args.indexOf('--case');
    const caseName = caseIdx === -1 ? null : args[caseIdx + 1];
    const includeExpensive = args.includes('--include-expensive');

    if (caseName) {
        const selected = SNAPSHOT_CASES.find(testCase => testCase.name === caseName);
        if (!selected) {
            throw new Error(`Unknown snapshot case "${caseName}". Available cases: ${SNAPSHOT_CASES.map(testCase => testCase.name).join(', ')}`);
        }
        return [selected];
    }

    const selected = includeExpensive ? SNAPSHOT_CASES : SNAPSHOT_CASES.filter(testCase => !testCase.expensive);
    if (!includeExpensive) {
        const skipped = SNAPSHOT_CASES.filter(testCase => testCase.expensive).map(testCase => testCase.name);
        if (skipped.length > 0) {
            console.warn(`Skipping expensive exhaustive snapshot(s): ${skipped.join(', ')}. Use --include-expensive or --case <name> to run them deliberately.`);
        }
    }
    return selected;
}

async function getStats(engine: EnchantEngine, testCase: SnapshotCase): Promise<EnchantStats> {
    const threshold = testCase.targetClassifiedMass === undefined
        ? TEST_DEFAULTS.SNAPSHOT_THRESHOLD
        : 0;

    return await engine.getStats({
        item: testCase.item,
        material: testCase.material,
        xp: testCase.xp,
        clue: testCase.clue,
        exhaustive: testCase.targetClassifiedMass === undefined ? TEST_DEFAULTS.SNAPSHOT_EXHAUSTIVE : false,
        threshold,
        maxIterations: testCase.maxIterations ?? TEST_DEFAULTS.SNAPSHOT_ITERATIONS,
        targetClassifiedMass: testCase.targetClassifiedMass,
        uncappedResults: true,
        useCache: false,
        instrumentation: createSnapshotInstrumentation()
    });
}

async function updateSnapshots() {
    console.log('Updating regression snapshots...');

    for (const testCase of getRequestedCases()) {
        console.log(`Generating ${testCase.name}...`);
        const engine = EngineFactory.createForVersion(testCase.version);
        engine.resetCaches();
        const stats = await getStats(engine, testCase);
        await SnapshotUtils.saveSnapshot(testCase.name, stats, engine.registry);
    }

    console.log('Regression snapshots updated successfully.');
}

updateSnapshots().catch(err => {
    console.error('Failed to update snapshots:', err);
    process.exit(1);
});
