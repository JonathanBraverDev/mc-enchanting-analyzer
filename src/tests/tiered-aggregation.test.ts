/**
 * Tests for StatAggregator.getFullStatsTiered — tiered search depth aggregation.
 *
 * sword/30/diamond is used throughout because it has ~65 valid combinations and
 * converges fully within a reasonable limit, making results deterministic and
 * comparable across approaches.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from '../engine/index.js';
import { StatAggregator } from '../engine/aggregator.js';
import { DATA } from '../data/index.js';
const CAT = 'sword';
const XP = 30;
const MAT = 'diamond';
const VERSION = '1.21';

describe('Tiered Aggregation: StatAggregator.getFullStatsTiered', () => {
    afterEach(() => {
        EnchantEngine.clearAllEngines();
    });

    // ── Test 1: tiered produces same final result as sequential getFullStats calls ──

    it('tiered produces same final result as sequential getFullStats calls', async () => {
        const engine = new EnchantEngine(DATA, VERSION);

        // Sequential: single getFullStats call with fine parameters
        const seqStats = await StatAggregator.getFullStats(
            engine.registry, CAT, XP, MAT, null,
            { threshold: 0.0001, resultsLimit: 10000, distCache: new Map(), poolCache: undefined }
        );

        // Tiered: two tiers ending at the same fine parameters
        const tieredStats = await StatAggregator.getFullStatsTiered(
            engine.registry, CAT, XP, MAT, null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: 0.0001, limit: 10000 },
            ],
            () => {},
            { threshold: 0.0001, resultsLimit: 10000, distCache: new Map(), poolCache: undefined }
        );

        // sword/30/diamond converges fully — combo sets must be identical,
        // and uncertainties must agree within integer-rounding tolerance (< 0.001)
        assert.strictEqual(
            Object.keys(tieredStats.combos).length,
            Object.keys(seqStats.combos).length,
            'Tiered and sequential must produce the same number of combos'
        );
        const uncertaintyDiff = Math.abs(tieredStats.uncertainty - seqStats.uncertainty);
        assert.ok(
            uncertaintyDiff < 0.001,
            `Tiered uncertainty (${tieredStats.uncertainty}) and sequential (${seqStats.uncertainty}) ` +
            `must agree within 0.001; got diff ${uncertaintyDiff}`
        );
    });

    // ── Test 2: onTierComplete fires for each tier ──────────────────────────────

    it('onTierComplete fires for each tier', async () => {
        const engine = new EnchantEngine(DATA, VERSION);
        const tiers = [
            { threshold: 0.01,   limit: 200 },
            { threshold: 0.001,  limit: 500 },
            { threshold: 0.0001, limit: 2000 },
        ];
        const callbackIndices: number[] = [];

        await StatAggregator.getFullStatsTiered(
            engine.registry, CAT, XP, MAT, null,
            tiers,
            (_stats, tierIndex) => { callbackIndices.push(tierIndex); },
            { distCache: new Map(), poolCache: undefined }
        );

        assert.deepStrictEqual(
            callbackIndices, [0, 1, 2],
            `onTierComplete must fire once per tier with the correct index. Got: ${JSON.stringify(callbackIndices)}`
        );
    });

    // ── Test 3: each tier improves on the previous ─────────────────────────────

    it('each tier improves on the previous (uncertainty decreases monotonically)', async () => {
        // Use book/30/book: millions of combinations guarantee the search never
        // fully converges within small iteration limits, so each deeper tier
        // produces strictly lower uncertainty than the previous.
        const engine = new EnchantEngine(DATA, VERSION);
        const uncertainties: number[] = [];

        await StatAggregator.getFullStatsTiered(
            engine.registry, 'book', 30, 'book', null,
            [
                { threshold: 0.1,    limit: 100 },
                { threshold: 0.01,   limit: 500 },
                { threshold: 0.001,  limit: 2000 },
            ],
            (stats) => { uncertainties.push(stats.uncertainty); },
            { distCache: new Map(), poolCache: undefined }
        );

        assert.ok(uncertainties.length === 3, `Expected 3 tier callbacks, got ${uncertainties.length}`);

        for (let i = 1; i < uncertainties.length; i++) {
            assert.ok(
                uncertainties[i] <= uncertainties[i - 1],
                `Tier ${i} uncertainty (${uncertainties[i]}) must be ≤ tier ${i - 1} (${uncertainties[i - 1]})`
            );
        }

        // At least one tier must strictly improve
        assert.ok(
            uncertainties[uncertainties.length - 1] < uncertainties[0],
            `Final tier uncertainty (${uncertainties[uncertainties.length - 1]}) must be strictly less than first tier (${uncertainties[0]})`
        );
    });

    // ── Test 4: single tier is equivalent to getFullStats ──────────────────────


    it('single tier is equivalent to getFullStats', async () => {
        const engine = new EnchantEngine(DATA, VERSION);

        const singleTierStats = await StatAggregator.getFullStatsTiered(
            engine.registry, CAT, XP, MAT, null,
            [{ threshold: 0.0001, limit: 5000 }],
            () => {},
            { threshold: 0.0001, resultsLimit: 10000, distCache: new Map(), poolCache: undefined }
        );

        const fullStats = await StatAggregator.getFullStats(
            engine.registry, CAT, XP, MAT, null,
            { threshold: 0.0001, resultsLimit: 10000, distCache: new Map(), poolCache: undefined }
        );

        assert.strictEqual(
            singleTierStats.uncertainty, fullStats.uncertainty,
            `Single-tier uncertainty (${singleTierStats.uncertainty}) must equal getFullStats (${fullStats.uncertainty})`
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
        EnchantEngine.clearAllEngines();
    });

    it('getFullStatsProgressive produces same result as getFullStats', async () => {
        const engine = new EnchantEngine(DATA, VERSION);

        const progressiveStats = await engine.getFullStatsProgressive(
            CAT, XP, MAT, null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: 0.0001, limit: 10000 },
            ],
            () => {}
        );

        // Reset caches so getFullStats runs fresh
        engine.resetCaches();

        const fullStats = await engine.getFullStats(CAT, XP, MAT, {
            threshold: 0.0001,
            resultsLimit: 10000
        });

        assert.strictEqual(
            Object.keys(progressiveStats.combos).length,
            Object.keys(fullStats.combos).length,
            'Progressive and getFullStats must produce the same number of combos'
        );
        const uncertaintyDiff = Math.abs(progressiveStats.uncertainty - fullStats.uncertainty);
        assert.ok(
            uncertaintyDiff < 0.001,
            `Progressive uncertainty (${progressiveStats.uncertainty}) and getFullStats (${fullStats.uncertainty}) ` +
            `must agree within 0.001; got diff ${uncertaintyDiff}`
        );
    });

    it('progressive caches only final result', async () => {
        const engine = new EnchantEngine(DATA, VERSION);

        const progressiveStats = await engine.getFullStatsProgressive(
            CAT, XP, MAT, null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: 0.0001, limit: 10000 },
            ],
            () => {}
        );

        // getFullStats with a coarse threshold should return the cached fine-precision result
        const cachedStats = await engine.getFullStats(CAT, XP, MAT, { threshold: 0.01 });

        assert.strictEqual(
            cachedStats.uncertainty,
            progressiveStats.uncertainty,
            'getFullStats should return the ultra-precision result cached by getFullStatsProgressive'
        );
    });

    it('progressive with cached result returns immediately', async () => {
        const engine = new EnchantEngine(DATA, VERSION);

        // Populate stats cache via getFullStats
        await engine.getFullStats(CAT, XP, MAT, { threshold: 0.0001 });

        let callbackFired = false;
        await engine.getFullStatsProgressive(
            CAT, XP, MAT, null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: 0.0001, limit: 10000 },
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
        const engine = new EnchantEngine(DATA, VERSION);

        const progressiveStats = await engine.getFullStatsProgressive(
            CAT, XP, MAT, null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: 0.0001, limit: 10000 },
            ],
            () => {}
        );

        // statsCache should contain a result; getFullStats must return it without recomputing
        const cachedResult = await engine.getFullStats(CAT, XP, MAT, { threshold: 0.0001 });

        assert.strictEqual(
            cachedResult.uncertainty,
            progressiveStats.uncertainty,
            'statsCache should contain the progressive result; getFullStats must return it'
        );
    });

    it('best intermediate result survives for future calls', async () => {
        const engine = new EnchantEngine(DATA, VERSION);
        const tierUncertainties: number[] = [];

        await engine.getFullStatsProgressive(
            CAT, XP, MAT, null,
            [
                { threshold: 0.1,    limit: 100 },
                { threshold: 0.01,   limit: 500 },
                { threshold: 0.0001, limit: 10000 },
            ],
            (stats) => { tierUncertainties.push(stats.uncertainty); }
        );

        assert.ok(
            tierUncertainties.length === 3,
            `Expected 3 tier callbacks, got ${tierUncertainties.length}`
        );

        // The ultra (finest) tier has the lowest uncertainty
        const ultraUncertainty = tierUncertainties[2];

        // A subsequent getFullStats call must return the ultra-tier cached result
        const futureStats = await engine.getFullStats(CAT, XP, MAT, { threshold: 0.0001 });

        assert.strictEqual(
            futureStats.uncertainty,
            ultraUncertainty,
            `getFullStats should return the ultra-tier cached result (uncertainty ${ultraUncertainty})`
        );
    });
});
