import { EngineTestUtils } from '#tests/infra/test-utils.js';
/**
 * Tests for EnchantEngine sequential checkpoint search.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory } from '#core/factory.js';
import { EngineFactory } from '#engine/factory.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { SummaryService } from '#services/SummaryService.js';
import { TEST_DATA } from '#tests/infra/test-data.js';
import { CacheConfig, SearchResult } from '#types/index.js';

const ITEM = TEST_DATA.ITEMS.SWORD;
const XP = 30;
const MATERIAL = TEST_DATA.MATERIALS.DIAMOND;
const VERSION = TEST_DATA.VERSIONS.MODERN;

describe('EnchantEngine: sequential checkpoint aggregation', () => {
    const cacheConfig: CacheConfig = { comboOtherSize: 1000, comboBookSize: 1000, poolSize: 1000 };
    let cache: CacheManager;

    function createEngine() {
        cache = new CacheManager(cacheConfig);
        return EngineFactory.create(RegistryFactory.build(VERSION), { cache });
    }

    afterEach(() => {
        cache.clearAll();
    });

    it('sequential checkpoints produce same final result as single checkpoint search', async () => {
        const engine = createEngine();

        const singleResult = await engine.searchToCheckpoint({
            item: ITEM,
            xp: XP,
            material: MATERIAL,
            threshold: TEST_DATA.THRESHOLDS.PROB_MIN,
            resultsLimit: 10000
        });
        const singleStats = SummaryService.summarize({
            combos: singleResult.combos,
            snapshot: singleResult.snapshot,
            indexToEnchant: engine.registry.indexToEnchant,
            comboLimit: 10000,
            threshold: singleResult.threshold
        });

        const sequentialResult = await engine.searchSequentialCheckpoints({
            item: ITEM,
            xp: XP,
            material: MATERIAL,
            checkpoints: [
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            onCheckpointComplete: () => {},
            threshold: TEST_DATA.THRESHOLDS.PROB_MIN,
            resultsLimit: 10000
        });
        const sequentialStats = SummaryService.summarize({
            combos: sequentialResult.combos,
            snapshot: sequentialResult.snapshot,
            indexToEnchant: engine.registry.indexToEnchant,
            comboLimit: 10000,
            threshold: sequentialResult.threshold
        });

        const accuracyDiff = Math.abs(sequentialStats.accuracy - singleStats.accuracy);
        assert.ok(accuracyDiff < 0.001, `Accuracy diff too high: ${accuracyDiff}`);
    });

    it('onCheckpointComplete fires for each checkpoint', async () => {
        const engine = createEngine();
        const checkpoints = [
            { threshold: 0.01,   limit: 200 },
            { threshold: 0.001,  limit: 500 },
            { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 2000 },
        ];
        const callbackIndices: number[] = [];

        await engine.searchSequentialCheckpoints({
            item: ITEM,
            xp: XP,
            material: MATERIAL,
            checkpoints,
            onCheckpointComplete: (_result: SearchResult, checkpointIndex: number) => { callbackIndices.push(checkpointIndex); }
        });

        assert.deepStrictEqual(callbackIndices, [0, 1, 2]);
    });

    it('returns the last completed checkpoint if aborted before processing the next checkpoint', async () => {
        const engine = createEngine();
        const completed: SearchResult[] = [];
        let armed = false;
        let allowedOuterCheckpointCheck = false;
        const signal = {
            get aborted() {
                if (!armed) return false;
                if (!allowedOuterCheckpointCheck) {
                    allowedOuterCheckpointCheck = true;
                    return false;
                }
                return true;
            }
        } as AbortSignal;

        const result = await engine.searchSequentialCheckpoints({
            item: ITEM,
            xp: XP,
            material: MATERIAL,
            checkpoints: [
                { threshold: 0.01, limit: 200 },
                { threshold: 0.001, limit: 500 },
            ],
            onCheckpointComplete: (checkpointResult: SearchResult) => {
                completed.push(checkpointResult);
                armed = true;
            },
            signal
        });

        assert.strictEqual(completed.length, 1);
        assert.strictEqual(result, completed[0]);
    });

    it('each checkpoint improves on the previous (accuracy increases monotonically)', async () => {
        const engine = createEngine();
        const accuracies: number[] = [];

        await engine.searchSequentialCheckpoints({
            item: TEST_DATA.ITEMS.BOOK,
            xp: 30,
            material: TEST_DATA.MATERIALS.BOOK,
            checkpoints: [
                { threshold: 0.1,    limit: 100 },
                { threshold: 0.01,   limit: 500 },
                { threshold: 0.001,  limit: 2000 },
            ],
            onCheckpointComplete: (result: SearchResult) => {
                accuracies.push(result.snapshot.mass.resolved);
            }
        });

        assert.strictEqual(accuracies.length, 3);
        for (let i = 1; i < accuracies.length; i++) {
            assert.ok((accuracies[i] ?? 0) >= (accuracies[i - 1] ?? 0));
        }
        assert.ok((accuracies[accuracies.length - 1] ?? 0) > (accuracies[0] ?? 0));
    });
});

describe('EnchantEngine checkpoint search', () => {
    afterEach(() => {
        const engine = EngineFactory.createForVersion(VERSION);
        engine.resetCaches();
    });

    it('searchSequentialCheckpoints produces same summarized result as direct stats helper', async () => {
        const engine = EngineFactory.createForVersion(VERSION);
        engine.resetCaches();

        const sequentialResult = await engine.searchSequentialCheckpoints({
            item: ITEM,
            xp: XP,
            material: MATERIAL,
            checkpoints: [
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            onCheckpointComplete: () => {}
        });
        const sequentialStats = SummaryService.summarize({
            combos: sequentialResult.combos,
            snapshot: sequentialResult.snapshot,
            indexToEnchant: engine.registry.indexToEnchant,
            comboLimit: 10000,
            threshold: sequentialResult.threshold
        });

        engine.resetCaches();

        const fullStats = await EngineTestUtils.getStats(engine, {
            item: ITEM,
            xp: XP,
            material: MATERIAL,
            threshold: TEST_DATA.THRESHOLDS.PROB_MIN,
            summaryLimit: 10000,
            resultsLimit: 10000
        });

        assert.strictEqual(Object.keys(sequentialStats.combos).length, Object.keys(fullStats.combos).length);
        const accuracyDiff = Math.abs(sequentialStats.accuracy - fullStats.accuracy);
        assert.ok(accuracyDiff < 0.001);
    });

    it('best checkpoint result survives for future calls', async () => {
        const engine = EngineFactory.createForVersion(VERSION);
        engine.resetCaches();
        const checkpointAccuracies: number[] = [];

        await engine.searchSequentialCheckpoints({
            item: ITEM,
            xp: XP,
            material: MATERIAL,
            checkpoints: [
                { threshold: 0.1,    limit: 100 },
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            onCheckpointComplete: (result) => { checkpointAccuracies.push(result.snapshot.mass.resolved); }
        });

        assert.strictEqual(checkpointAccuracies.length, 3);
        const ultraAccuracy = checkpointAccuracies[2];
        const futureResult = await engine.searchToCheckpoint({ item: ITEM, xp: XP, material: MATERIAL, threshold: TEST_DATA.THRESHOLDS.PROB_MIN });
        assert.strictEqual(futureResult.snapshot.mass.resolved, ultraAccuracy);
    });

});
