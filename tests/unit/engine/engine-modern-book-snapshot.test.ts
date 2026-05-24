import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { TEST_DEFAULTS } from '#constants/testing.js';
import { TEST_DATA } from '#tests/infra/test-data.js';
import { SnapshotUtils } from '#tests/infra/test-utils.js';
import { SummaryService } from '#services/SummaryService.js';
import { RegistryKernel } from '#lib/search/index.js';
import { SearchRun } from '#lib/search/SearchRun.js';

// Polyfill for requestAnimationFrame in Node (Sync version for tests)
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: Function) => callback(Date.now());
}

describe('Modern Book Mass-Targeted Regression Snapshot', () => {
    it('Snapshot: 1.21.11 Book @ Level 30 (99.95% classified mass)', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const kernel = new RegistryKernel({
            registry: engine.registry,
            item: TEST_DATA.ITEMS.BOOK,
            material: TEST_DATA.MATERIALS.BOOK
        });
        const run = new SearchRun(kernel);
        run.seedXp(30);

        const snapshot = run.searchToCheckpoint({
            threshold: 0,
            maxIterations: TEST_DEFAULTS.MODERN_BOOK_SNAPSHOT_ITERATIONS,
            targetClassifiedMass: TEST_DEFAULTS.MODERN_BOOK_SNAPSHOT_TARGET_CLASSIFIED_MASS
        });
        const stats = SummaryService.summarize({
            combos: snapshot.results,
            snapshot,
            indexToEnchant: engine.registry.indexToEnchant,
            uncappedResults: true,
            threshold: 0,
            isBook: true
        });

        const classifiedMass = 1 - stats.accounting.pending;
        assert.ok(
            classifiedMass >= TEST_DEFAULTS.MODERN_BOOK_SNAPSHOT_TARGET_CLASSIFIED_MASS,
            `Expected classified mass >= ${TEST_DEFAULTS.MODERN_BOOK_SNAPSHOT_TARGET_CLASSIFIED_MASS}, got ${classifiedMass}`
        );

        await SnapshotUtils.assertSnapshot('1.21.11_book_30_book', stats, engine.registry);
    });
});
