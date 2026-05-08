/**
 * Integration tests for frontier resumability and cache behavior.
 *
 * NOTE (Test B): limit is no longer included in the frontier cache key
 * (KeyUtils.getPackedKey), so cross-tier frontier cache sharing is possible within a
 * single engine. However, to isolate the threshold-driven quality difference cleanly,
 * we use two separate engines so the coarse stats-cache result does not short-circuit
 * the deep run.
 *
 * NOTE (Tests C & D): The stats cache key excludes both limit and threshold, so any
 * previously cached result satisfies all later requests on the same
 * (item, material, xp, guaranteed) tuple regardless of the threshold requested.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';

describe('Frontier Resumability & Cache Behavior', () => {

    // ── Test B: Progressive refinement improves accuracy ─────────────────────
    //
    // NOTE: Two separate engines are used to prevent the coarse stats-cache result
    // from short-circuiting the deep run. The test validates that a tighter threshold
    // (0.0001) drives genuinely lower pending mass than a coarser one (0.01) for the
    // same input, independent of cache sharing.
    // NOTE: limit is no longer in the frontier cache key (see KeyUtils.getPackedKey),
    // so cross-tier frontier cache sharing is now correct; this test intentionally avoids
    // it to keep the assertion clean.

    it('progressive refinement improves accuracy (decreases pending mass)', async () => {
        // Coarse engine: threshold=0.01 — search stops when queue-top prob < 0.001
        EngineFactory.clearCaches();
        const coarseEngine = EngineFactory.createForVersion('1.21');
        const coarseResult = await coarseEngine.calculate({
            item: 'sword',
            xp: 30,
            material: 'diamond',
            threshold: 0.01,
            resultsLimit: 1000
        });

        // Deep engine: threshold=0.0001 — search stops when queue-top prob < 0.00001,
        // exploring far more of the probability mass before stopping.
        // A fresh engine ensures the stats cache from the coarse run doesn't interfere.
        EngineFactory.clearCaches();
        const deepEngine = EngineFactory.createForVersion('1.21');
        const deepResult = await deepEngine.calculate({
            item: 'sword',
            xp: 30,
            material: 'diamond',
            threshold: 0.0001,
            resultsLimit: 1000
        });

        assert.ok(
            deepResult.accounting.pending < coarseResult.accounting.pending,
            `Deep pending mass (${deepResult.accounting.pending}) must be strictly less than ` +
            `coarse pending mass (${coarseResult.accounting.pending})`
        );
    });

    // ── Test C: Stats cache returns cached result immediately ───────────────

    it('stats cache returns cached result immediately', async () => {
        const engine = EngineFactory.createForVersion('1.21');

        // First call: computes stats and stores them in the stats cache.
        const result1 = await engine.calculate({ item: 'sword', xp: 30, material: 'diamond', threshold: 0.001, resultsLimit: 1000 });

        // Second call with identical params: stats cache hit, returns the same object.
        const result2 = await engine.calculate({ item: 'sword', xp: 30, material: 'diamond', threshold: 0.001, resultsLimit: 1000 });

        assert.strictEqual(result1, result2,
            'Second getFullStats call with same params should return the exact same cached object');
    });

    // ── Test E: Cross-tier resumption through frontier cache ────────────────
    //
    // Same engine: coarse run populates the frontier cache, then only statsCache is cleared.
    // Deep run must resume from the cached coarse frontiers (not start from scratch),
    // producing strictly higher accuracy than the coarse run.

    it('cross-tier frontier cache: deep run resumes from coarse frontier', async () => {
        EngineFactory.clearCaches();
        const engine = EngineFactory.createForVersion('1.21');

        // Coarse pass: populates both statsCache and frontier cache.
        const coarseResult = await engine.calculate({
            item: 'sword',
            xp: 30,
            material: 'diamond',
            threshold: 0.01,
            resultsLimit: 1000
        });

        // Clear only the statsCache; frontier cache retains the coarse frontiers.
        engine.resetStatsCache();

        // Deep pass: statsCache miss forces recomputation, but frontier cache hit
        // lets each modLevel search resume from the already-explored coarse frontier.
        const deepResult = await engine.calculate({
            item: 'sword',
            xp: 30,
            material: 'diamond',
            threshold: 0.0001,
            resultsLimit: 1000
        });

        assert.ok(
            deepResult.accounting.pending < coarseResult.accounting.pending,
            `Deep run (threshold=0.0001) must produce strictly lower pending mass than coarse run ` +
            `(threshold=0.01). Coarse: ${coarseResult.accounting.pending}, Deep: ${deepResult.accounting.pending}`
        );
    });

    // ── Test D: Ultra result satisfies coarse request via stats cache ────────

    it('sequential checkpoints produce same final result as repeated calculate calls', async () => {
        const engine = EngineFactory.createForVersion('1.21');

        // Ultra run first: produces low-uncertainty stats, cached at K_stats.
        // The stats key excludes limit and threshold, so K_stats is the same
        // for any config on the same (item, material, xp, guaranteed) tuple.
        const ultraResult = await engine.calculate({
            item: 'sword',
            xp: 30,
            material: 'diamond',
            threshold: 0.00001,
            maxIterations: 200
        });

        // Coarse run: looks up the same K_stats → immediate stats cache hit.
        // Returns the already-cached ultra result without recomputing.
        const coarseResult = await engine.calculate({
            item: 'sword',
            xp: 30,
            material: 'diamond',
            threshold: 0.1, // use a very coarse threshold to be safe
            maxIterations: 20
        });

        assert.strictEqual(coarseResult, ultraResult,
            'Coarse getFullStats should return the cached ultra result (cross-tier stats cache hit)');
        assert.strictEqual(coarseResult.accuracy, ultraResult.accuracy,
            'Coarse and ultra accuracy must be identical when served from cache');

        // Cache is instance-local
    });
});
