import { describe, it } from 'node:test';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { SnapshotUtils } from '#tests/infra/test-utils.js';
import { TEST_DEFAULTS } from '#constants/testing.js';
import { TEST_DATA } from '#tests/infra/test-data.js';

// Polyfill for requestAnimationFrame in Node (Sync version for tests)
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: Function) => callback(Date.now());
}

describe('Enchantment Engine Regression Snapshots', () => {
    it('Snapshot: 1.8 Diamond Sword @ Level 30', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.LAPIS_PIVOT);
        const stats = await engine.calculate({ cat: TEST_DATA.ITEMS.SWORD, xp: 30, mat: TEST_DATA.MATERIALS.DIAMOND, threshold: TEST_DEFAULTS.SNAPSHOT_THRESHOLD, maxIterations: TEST_DEFAULTS.SNAPSHOT_ITERATIONS, summaryLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, resultsLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, useCache: false });
        await SnapshotUtils.assertSnapshot('1.8_sword_30_diamond', stats, engine.registry);
    });

    it('Snapshot: 1.21 Mace @ Level 30', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        const stats = await engine.calculate({ cat: TEST_DATA.ITEMS.MACE, xp: 30, mat: TEST_DATA.MATERIALS.MACE, threshold: TEST_DEFAULTS.SNAPSHOT_THRESHOLD, maxIterations: TEST_DEFAULTS.SNAPSHOT_ITERATIONS, summaryLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, resultsLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, useCache: false });
        await SnapshotUtils.assertSnapshot('1.21_mace_30_mace', stats, engine.registry);
    });

    it('Snapshot: 1.21.11 Spear @ Level 30', async () => {
        const engine = EngineFactory.create(DATA, '1.21.11');
        const stats = await engine.calculate({ cat: TEST_DATA.ITEMS.SPEAR, xp: 30, mat: TEST_DATA.MATERIALS.DIAMOND, threshold: TEST_DEFAULTS.SNAPSHOT_THRESHOLD, maxIterations: TEST_DEFAULTS.SNAPSHOT_ITERATIONS, summaryLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, resultsLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, useCache: false });
        await SnapshotUtils.assertSnapshot('1.21.11_spear_30_diamond', stats, engine.registry);
    });

    it('Snapshot: 1.21 Diamond Sword @ Level 30 (Clue Sharpness IV)', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        engine.resetCaches();
        const stats = await engine.calculate({ cat: TEST_DATA.ITEMS.SWORD, xp: 30, mat: TEST_DATA.MATERIALS.DIAMOND, threshold: TEST_DEFAULTS.SNAPSHOT_THRESHOLD, maxIterations: TEST_DEFAULTS.SNAPSHOT_ITERATIONS, summaryLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, resultsLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, useCache: false, clue: 'Sharpness IV' });
        await SnapshotUtils.assertSnapshot('1.21_sword_30_diamond_clue_sharpness', stats, engine.registry);
    });

    it('Snapshot: 1.8 Bow @ Level 30 (Clue Power IV)', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.LAPIS_PIVOT);
        engine.resetCaches();
        const stats = await engine.calculate({ cat: TEST_DATA.ITEMS.BOW, xp: 30, mat: TEST_DATA.MATERIALS.BOW, threshold: TEST_DEFAULTS.SNAPSHOT_THRESHOLD, maxIterations: TEST_DEFAULTS.SNAPSHOT_ITERATIONS, summaryLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, resultsLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, useCache: false, clue: 'Power IV' });
        await SnapshotUtils.assertSnapshot('1.8_bow_30_bow_clue_power', stats, engine.registry);
    });

    it('Snapshot: 1.7.2 Multi-Enchant Book @ Level 30', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.BOOK_MULTI_LIMIT);
        const stats = await engine.calculate({ cat: TEST_DATA.ITEMS.BOOK, xp: 30, mat: TEST_DATA.MATERIALS.BOOK, threshold: TEST_DEFAULTS.SNAPSHOT_THRESHOLD, maxIterations: TEST_DEFAULTS.SNAPSHOT_ITERATIONS, summaryLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, resultsLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, useCache: false });
        await SnapshotUtils.assertSnapshot('1.7.2_book_30_book', stats, engine.registry);
    });

    it('Snapshot: 1.21.11 Book @ Level 30', async () => {
        const engine = EngineFactory.create(DATA, '1.21.11');
        engine.resetCaches();
        const stats = await engine.calculate({ cat: TEST_DATA.ITEMS.BOOK, xp: 30, mat: TEST_DATA.MATERIALS.BOOK, threshold: TEST_DEFAULTS.SNAPSHOT_THRESHOLD, maxIterations: TEST_DEFAULTS.SNAPSHOT_ITERATIONS, summaryLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, resultsLimit: TEST_DEFAULTS.SNAPSHOT_RESULTS_LIMIT, useCache: false });
        await SnapshotUtils.assertSnapshot('1.21.11_book_30_book', stats, engine.registry);
    });
});
