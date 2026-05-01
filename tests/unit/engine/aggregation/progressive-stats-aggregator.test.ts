/**
 * Tests for ProgressiveStatsAggregator sequential checkpoint search.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { ProgressiveStatsAggregator } from '#engine/aggregation/ProgressiveStatsAggregator.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchService } from '#engine/search/SearchService.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { SummaryService } from '#services/SummaryService.js';
import { DATA } from '#data/index.js';
import { TEST_DATA } from '#tests/infra/test-data.js';
import { CacheConfig, SearchResult } from '#types/index.js';

const CAT = TEST_DATA.ITEMS.SWORD;
const XP = 30;
const MAT = TEST_DATA.MATERIALS.DIAMOND;
const VERSION = TEST_DATA.VERSIONS.MODERN;

describe('ProgressiveStatsAggregator: sequential checkpoint aggregation', () => {
    const cacheConfig: CacheConfig = { comboOtherSize: 1000, comboBookSize: 1000, statsSize: 100, poolSize: 1000 };
    const cache = new CacheManager(cacheConfig);
    const distService = new ModifiedLevelDistributionService(1024);
    const searchService = new SearchService(cache);
    const aggregator = new ProgressiveStatsAggregator(cache, distService, searchService);

    afterEach(() => {
        cache.clearAll();
    });

    it('sequential checkpoints produce same final result as single checkpoint search', async () => {
        const engine = EngineFactory.create(DATA, VERSION, {
            statAggregator: aggregator,
            cache: cache,
            distributionService: distService,
            searchService: searchService
        });

        // Sequential
        const singleResult = await aggregator.searchToCheckpoint(
            engine.registry, CAT, XP, MAT,
            { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, resultsLimit: 10000 }
        );
        const singleStats = SummaryService.summarize(singleResult.combos, singleResult.tracker, engine.registry.indexToEnchant, 10000, singleResult.threshold);

        const sequentialResult = await aggregator.searchSequentialCheckpoints(
            engine.registry, CAT, XP, MAT,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            () => {},
            { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, resultsLimit: 10000 }
        );
        const sequentialStats = SummaryService.summarize(sequentialResult.combos, sequentialResult.tracker, engine.registry.indexToEnchant, 10000, sequentialResult.threshold);

        const accuracyDiff = Math.abs(sequentialStats.accuracy - singleStats.accuracy);
        assert.ok(accuracyDiff < 0.001, `Accuracy diff too high: ${accuracyDiff}`);
    });

    it('onCheckpointComplete fires for each checkpoint', async () => {
        const engine = EngineFactory.create(DATA, VERSION, {
            statAggregator: aggregator,
            cache: cache
        });
        const checkpoints = [
            { threshold: 0.01,   limit: 200 },
            { threshold: 0.001,  limit: 500 },
            { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 2000 },
        ];
        const callbackIndices: number[] = [];

        await aggregator.searchSequentialCheckpoints(
            engine.registry, CAT, XP, MAT,
            checkpoints,
            (_result: SearchResult, checkpointIndex: number) => { callbackIndices.push(checkpointIndex); },
            {}
        );

        assert.deepStrictEqual(callbackIndices, [0, 1, 2]);
    });

    it('each checkpoint improves on the previous (accuracy increases monotonically)', async () => {
        const engine = EngineFactory.create(DATA, VERSION, {
            statAggregator: aggregator,
            cache: cache
        });
        const accuracies: number[] = [];

        await aggregator.searchSequentialCheckpoints(
            engine.registry, TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK,
            [
                { threshold: 0.1,    limit: 100 },
                { threshold: 0.01,   limit: 500 },
                { threshold: 0.001,  limit: 2000 },
            ],
            (result: SearchResult) => {
                accuracies.push(result.tracker.mass.toPublic().resolved);
            },
            {}
        );

        assert.strictEqual(accuracies.length, 3);
        for (let i = 1; i < accuracies.length; i++) {
            assert.ok((accuracies[i] ?? 0) >= (accuracies[i - 1] ?? 0));
        }
        assert.ok((accuracies[accuracies.length - 1] ?? 0) > (accuracies[0] ?? 0));
    });
});

describe('EnchantEngine.calculateProgressive', () => {
    afterEach(() => {
        const engine = EngineFactory.create(DATA, VERSION);
        engine.resetCaches();
    });

    it('calculateProgressive produces same result as calculate', async () => {
        const engine = EngineFactory.create(DATA, VERSION);
        engine.resetCaches();

        const progressiveStats = await engine.calculateProgressive(
            CAT, XP, MAT,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            () => {}
        );

        engine.resetCaches();

        const fullStats = await engine.calculate(CAT, XP, MAT, {
            threshold: TEST_DATA.THRESHOLDS.PROB_MIN,
            resultsLimit: 10000
        });

        assert.strictEqual(Object.keys(progressiveStats.combos).length, Object.keys(fullStats.combos).length);
        const accuracyDiff = Math.abs(progressiveStats.accuracy - fullStats.accuracy);
        assert.ok(accuracyDiff < 0.001);
    });

    it('best intermediate result survives for future calls', async () => {
        const engine = EngineFactory.create(DATA, VERSION);
        engine.resetCaches();
        const checkpointAccuracies: number[] = [];

        await engine.calculateProgressive(
            CAT, XP, MAT,
            [
                { threshold: 0.1,    limit: 100 },
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            (stats) => { checkpointAccuracies.push(stats.accuracy); }
        );

        assert.strictEqual(checkpointAccuracies.length, 3);
        const ultraAccuracy = checkpointAccuracies[2];
        const futureStats = await engine.calculate(CAT, XP, MAT, { threshold: TEST_DATA.THRESHOLDS.PROB_MIN });
        assert.strictEqual(futureStats.accuracy, ultraAccuracy);
    });
});
