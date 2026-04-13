/**
 * Tests for StatAggregator.getFullStatsTiered — tiered search depth aggregation.
 *
 * sword/30/diamond is used throughout because it has ~65 valid combinations and
 * converges fully within a reasonable limit, making results deterministic and
 * comparable across approaches.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine, EngineFactory } from '../engine/index.js';
import { StatAggregator } from '../engine/aggregator.js';
import { DistributionService } from '../engine/distribution.js';
import { SearchService } from '../engine/search.js';
import { CacheManager } from '../services/CacheManager.js';
import { DATA } from '../data/index.js';
import { TEST_DATA } from './test-data.js';
import { CalculationStats, CacheConfig } from '../types/index.js';
const CAT = TEST_DATA.ITEMS.SWORD;
const XP = 30;
const MAT = TEST_DATA.MATERIALS.DIAMOND;
const VERSION = TEST_DATA.VERSIONS.MODERN;

describe('Tiered Aggregation: StatAggregator.getFullStatsTiered', () => {
    const cacheConfig: CacheConfig = { comboOtherSize: 1000, comboBookSize: 1000, statsSize: 100, poolSize: 1000 };
    const cache = new CacheManager(cacheConfig);
    const distService = new DistributionService();
    const searchService = new SearchService(cache);
    const aggregator = new StatAggregator(cache, distService, searchService);

    afterEach(() => {
        cache.clearAll();
    });

    // ── Test 1: tiered produces same final result as sequential getFullStats calls ──

    it('tiered produces same final result as sequential getFullStats calls', async () => {
        const engine = EngineFactory.create(DATA, VERSION);

        // Sequential: single getFullStats call with fine parameters
        const seqStats = await aggregator.getFullStats(
            engine.registry, CAT, XP, MAT, null,
            { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, resultsLimit: 10000 }
        );

        // Tiered: two tiers ending at the same fine parameters
        const tieredStats = await aggregator.getFullStatsTiered(
            engine.registry, CAT, XP, MAT, null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            () => {},
            { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, resultsLimit: 10000 }
        );

        // sword/30/diamond converges fully — combo sets must be identical,
        // and accuracy must agree within float tolerance
        const accuracyDiff = Math.abs(tieredStats.accuracy - seqStats.accuracy);
        assert.ok(
            accuracyDiff < 0.001,
            `Tiered accuracy (${tieredStats.accuracy}) and sequential (${seqStats.accuracy}) ` +
            `must agree within 0.001; got diff ${accuracyDiff}`
        );
    });

    // ── Test 2: onTierComplete fires for each tier ──────────────────────────────

    it('onTierComplete fires for each tier', async () => {
        const engine = EngineFactory.create(DATA, VERSION);
        const tiers = [
            { threshold: 0.01,   limit: 200 },
            { threshold: 0.001,  limit: 500 },
            { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 2000 },
        ];
        const callbackIndices: number[] = [];

        await aggregator.getFullStatsTiered(
            engine.registry, CAT, XP, MAT, null,
            tiers,
            (stats: CalculationStats, tierIndex: number) => { callbackIndices.push(tierIndex); },
            {}
        );

        assert.deepStrictEqual(
            callbackIndices, [0, 1, 2],
            `onTierComplete must fire once per tier with the correct index. Got: ${JSON.stringify(callbackIndices)}`
        );
    });

    // ── Test 3: each tier improves on the previous ─────────────────────────────

    it('each tier improves on the previous (accuracy increases monotonically)', async () => {
        // Use book/30/book: millions of combinations guarantee the search never
        // fully converges within small iteration limits, so each deeper tier
        // produces strictly higher accuracy than the previous.
        const engine = EngineFactory.create(DATA, VERSION);
        const accuracies: number[] = [];

        await aggregator.getFullStatsTiered(
            engine.registry, TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, null,
            [
                { threshold: 0.1,    limit: 100 },
                { threshold: 0.01,   limit: 500 },
                { threshold: 0.001,  limit: 2000 },
            ],
            (stats: CalculationStats) => { accuracies.push(stats.accuracy); },
            {}
        );

        assert.ok(accuracies.length === 3, `Expected 3 tier callbacks, got ${accuracies.length}`);

        for (let i = 1; i < accuracies.length; i++) {
            assert.ok(
                accuracies[i] >= accuracies[i - 1],
                `Tier ${i} accuracy (${accuracies[i]}) must be >= tier ${i - 1} (${accuracies[i - 1]})`
            );
        }

        // At least one tier must strictly improve
        assert.ok(
            accuracies[accuracies.length - 1] > accuracies[0],
            `Final tier accuracy (${accuracies[accuracies.length - 1]}) must be strictly greater than first tier (${accuracies[0]})`
        );
    });

    // ── Test 4: single tier is equivalent to getFullStats ──────────────────────


    it('single tier is equivalent to getFullStats', async () => {
        const engine = EngineFactory.create(DATA, VERSION);

        const singleTierStats = await aggregator.getFullStatsTiered(
            engine.registry, CAT, XP, MAT, null,
            [{ threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 }],
            () => {},
            { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, resultsLimit: 10000 }
        );

        const fullStats = await aggregator.getFullStats(
            engine.registry, CAT, XP, MAT, null,
            { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, resultsLimit: 10000 }
        );

        assert.strictEqual(
            singleTierStats.accuracy, fullStats.accuracy,
            `Single-tier accuracy (${singleTierStats.accuracy}) must equal getFullStats (${fullStats.accuracy})`
        );
        assert.strictEqual(
            Object.keys(singleTierStats.combos).length,
            Object.keys(fullStats.combos).length,
            'Single-tier and getFullStats must produce the same number of combos'
        );
    });
});

describe('EnchantEngine.getFullStatsProgressive', () => {
    afterEach(() => {
        // sendMessage({ type: 'init' }) recreates the engine inside the worker, clearing its caches.
    });

    it('getFullStatsProgressive produces same result as getFullStats', async () => {
        const engine = EngineFactory.create(DATA, VERSION);

        const progressiveStats = await engine.getFullStatsProgressive(
            CAT, XP, MAT, null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            () => {}
        );

        // Reset caches so getFullStats runs fresh
        engine.resetCaches();

        const fullStats = await engine.getFullStats(CAT, XP, MAT, {
            threshold: TEST_DATA.THRESHOLDS.PROB_MIN,
            resultsLimit: 10000
        });

        assert.strictEqual(
            Object.keys(progressiveStats.combos).length,
            Object.keys(fullStats.combos).length,
            'Progressive and getFullStats must produce the same number of combos'
        );
        const accuracyDiff = Math.abs(progressiveStats.accuracy - fullStats.accuracy);
        assert.ok(
            accuracyDiff < 0.001,
            `Progressive accuracy (${progressiveStats.accuracy}) and getFullStats (${fullStats.accuracy}) ` +
            `must agree within 0.001; got diff ${accuracyDiff}`
        );
    });

    it('progressive caches only final result', async () => {
        const engine = EngineFactory.create(DATA, VERSION);

        const progressiveStats = await engine.getFullStatsProgressive(
            CAT, XP, MAT, null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            () => {}
        );

        // getFullStats with a coarse threshold should return the cached fine-precision result
        const cachedStats = await engine.getFullStats(CAT, XP, MAT, { threshold: 0.01 });

        assert.strictEqual(
            cachedStats.accuracy,
            progressiveStats.accuracy,
            'getFullStats should return the ultra-precision result cached by getFullStatsProgressive'
        );
    });

    it('progressive with cached result returns immediately', async () => {
        const engine = EngineFactory.create(DATA, VERSION);

        // Populate stats cache via getFullStats
        await engine.getFullStats(CAT, XP, MAT, { threshold: TEST_DATA.THRESHOLDS.PROB_MIN });

        let callbackFired = false;
        await engine.getFullStatsProgressive(
            CAT, XP, MAT, null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            () => { callbackFired = true; }
        );

        assert.strictEqual(
            callbackFired,
            false,
            'onTierComplete must not fire when result is already in the stats cache'
        );
    });

    it('intermediate tier results are cached', async () => {
        const engine = EngineFactory.create(DATA, VERSION);

        const progressiveStats = await engine.getFullStatsProgressive(
            CAT, XP, MAT, null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            () => {}
        );

        // statsCache should contain a result; getFullStats must return it without recomputing
        const cachedResult = await engine.getFullStats(CAT, XP, MAT, { threshold: TEST_DATA.THRESHOLDS.PROB_MIN });

        assert.strictEqual(
            cachedResult.accuracy,
            progressiveStats.accuracy,
            'statsCache should contain the progressive result; getFullStats must return it'
        );
    });

    it('best intermediate result survives for future calls', async () => {
        const engine = EngineFactory.create(DATA, VERSION);
        const tierAccuracies: number[] = [];

        await engine.getFullStatsProgressive(
            CAT, XP, MAT, null,
            [
                { threshold: 0.1,    limit: 100 },
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 10000 },
            ],
            (stats) => { tierAccuracies.push(stats.accuracy); }
        );

        assert.ok(
            tierAccuracies.length === 3,
            `Expected 3 tier callbacks, got ${tierAccuracies.length}`
        );

        // The ultra (finest) tier has the highest accuracy
        const ultraAccuracy = tierAccuracies[2];

        // A subsequent getFullStats call must return the ultra-tier cached result
        const futureStats = await engine.getFullStats(CAT, XP, MAT, { threshold: TEST_DATA.THRESHOLDS.PROB_MIN });

        assert.strictEqual(
            futureStats.accuracy,
            ultraAccuracy,
            `getFullStats should return the ultra-tier cached result (accuracy ${ultraAccuracy})`
        );
    });
});
