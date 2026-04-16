/**
 * Tests for StatAggregator.getFullStatsTiered — tiered search depth aggregation.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { StatAggregator } from '#engine/aggregation/StatAggregator.js';
import { DistributionService } from '#engine/distribution/DistributionService.js';
import { SearchService } from '#engine/search/SearchService.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { SummaryService } from '#services/SummaryService.js';
import { DATA } from '#data/index.js';
import { TEST_DATA } from '../../infra/test-data.js';
import { CacheConfig, AggregationResult } from '#types/index.js';

const CAT = TEST_DATA.ITEMS.SWORD;
const XP = 30;
const MAT = TEST_DATA.MATERIALS.DIAMOND;
const VERSION = TEST_DATA.VERSIONS.MODERN;

describe('Tiered Aggregation: StatAggregator.getFullStatsTiered', () => {
    const cacheConfig: CacheConfig = { comboOtherSize: 1000, comboBookSize: 1000, statsSize: 100, poolSize: 1000 };
    const cache = new CacheManager(cacheConfig);
    const distService = new DistributionService(1024);
    const searchService = new SearchService(cache);
    const aggregator = new StatAggregator(cache, distService, searchService);

    afterEach(() => {
        cache.clearAll();
    });

    it('tiered produces same final result as sequential calculate calls', async () => {
        const engine = EngineFactory.create(DATA, VERSION, { 
            statAggregator: aggregator,
            cache: cache,
            distributionService: distService,
            searchService: searchService
        });

        // Sequential
        const seqRaw = await aggregator.calculate(
            engine.registry, CAT, XP, MAT, null,
            { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, resultsLimit: 10000 }
        );
        const seqStats = SummaryService.summarize(seqRaw.combos, seqRaw.tracker, seqRaw.anyMass, seqRaw.rankMass, seqRaw.countMass, 10000, seqRaw.threshold);

        // Tiered
        const tieredRaw = await aggregator.calculateTiered(
            engine.registry, CAT, XP, MAT, null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            () => {},
            { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, resultsLimit: 10000 }
        );
        const tieredStats = SummaryService.summarize(tieredRaw.combos, tieredRaw.tracker, tieredRaw.anyMass, tieredRaw.rankMass, tieredRaw.countMass, 10000, tieredRaw.threshold);

        const accuracyDiff = Math.abs(tieredStats.accuracy - seqStats.accuracy);
        assert.ok(accuracyDiff < 0.001, `Accuracy diff too high: ${accuracyDiff}`);
    });

    it('onTierComplete fires for each tier', async () => {
        const engine = EngineFactory.create(DATA, VERSION, { 
            statAggregator: aggregator,
            cache: cache
        });
        const tiers = [
            { threshold: 0.01,   limit: 200 },
            { threshold: 0.001,  limit: 500 },
            { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 2000 },
        ];
        const callbackIndices: number[] = [];

        await aggregator.calculateTiered(
            engine.registry, CAT, XP, MAT, null,
            tiers,
            (_raw: AggregationResult, tierIndex: number) => { callbackIndices.push(tierIndex); },
            {}
        );

        assert.deepStrictEqual(callbackIndices, [0, 1, 2]);
    });

    it('each tier improves on the previous (accuracy increases monotonically)', async () => {
        const engine = EngineFactory.create(DATA, VERSION, { 
            statAggregator: aggregator,
            cache: cache
        });
        const accuracies: number[] = [];

        await aggregator.calculateTiered(
            engine.registry, TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, null,
            [
                { threshold: 0.1,    limit: 100 },
                { threshold: 0.01,   limit: 500 },
                { threshold: 0.001,  limit: 2000 },
            ],
            (raw: AggregationResult) => { 
                accuracies.push(raw.tracker.toPublic().resolved); 
            },
            {}
        );

        assert.strictEqual(accuracies.length, 3);
        for (let i = 1; i < accuracies.length; i++) {
            assert.ok(accuracies[i] >= accuracies[i - 1]);
        }
        assert.ok(accuracies[accuracies.length - 1] > accuracies[0]);
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
            CAT, XP, MAT, null,
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
        const tierAccuracies: number[] = [];

        await engine.calculateProgressive(
            CAT, XP, MAT, null,
            [
                { threshold: 0.1,    limit: 100 },
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            (stats) => { tierAccuracies.push(stats.accuracy); }
        );

        assert.strictEqual(tierAccuracies.length, 3);
        const ultraAccuracy = tierAccuracies[2];
        const futureStats = await engine.calculate(CAT, XP, MAT, { threshold: TEST_DATA.THRESHOLDS.PROB_MIN });
        assert.strictEqual(futureStats.accuracy, ultraAccuracy);
    });
});
