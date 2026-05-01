/**
 * Integration tests for frontier resumability and cache behavior.
 *
 * NOTE (Test A): book/ml=50 is used instead of sword/diamond because sword's
 * ~65 valid enchantment combinations are exhausted well within 500 iterations
 * (condition 3 — 99.99 % mass accounted — fires before the limit). When the first
 * run exits via condition 3 rather than the limit, the resumed run's while-loop
 * terminates immediately (cumulativeAccountedMass is restored from the frontier and
 * already at the threshold), producing no improvement. Book at ml=50 has millions of
 * reachable combinations, guaranteeing the limit is the binding constraint.
 *
 * NOTE (Test B): limit is no longer included in the combo cache key
 * (KeyUtils.getPackedKey), so cross-tier combo cache sharing is possible within a
 * single engine. However, to isolate the threshold-driven quality difference cleanly,
 * we use two separate engines so the coarse stats-cache result does not short-circuit
 * the deep run.
 *
 * NOTE (Tests C & D): The stats cache key excludes both limit and threshold, so any
 * previously cached result satisfies all later requests on the same
 * (cat, mat, xp, guaranteed) tuple regardless of the threshold requested.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { SearchService } from '#engine/search/SearchService.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { DATA } from '#data/index.js';
import { ProbUtils } from '#utils/index.js';

describe('Frontier Resumability & Cache Behavior', () => {

    // ── Test A: SearchService direct resumption ─────────────────────────────

    it('SearchService resumes from existing frontier', async () => {
        const engine = EngineFactory.create(DATA, '1.21');
        const cache = new CacheManager({ poolSize: 100, comboOtherSize: 100, comboBookSize: 100, statsSize: 100 });
        const searchService = new SearchService(cache);

        // book/ml=50 has millions of reachable combinations; 500 iterations barely
        // scratch the surface, so the limit — not mass convergence — is the
        // binding exit condition.  sword/diamond has only ~65 valid combinations
        // and always converges before reaching the limit, making resumption a no-op.
        const threshold = ProbUtils.toBigInt(0.0001);
        const cat = 'book', ml = 50;

        // First pass: 500 iterations from the initial state
        const result500 = await searchService.search(
            engine.registry, cat, ml, undefined, { threshold, limit: 500, resultsLimit: 1000 }
        );

        // Second pass: 2 000 more iterations, resuming from result500
        const result2000 = await searchService.search(
            engine.registry, cat, ml, result500, { threshold, limit: 2000, resultsLimit: 1000 }
        );

        assert.ok(result500.results.size > 0, 'First run should have produced results');
        assert.ok(result2000.results.size > 0, 'Resumed run should have produced results');

        assert.ok(
            result2000.results.size >= result500.results.size,
            'Resumed run must not have fewer results than the first run'
        );
        assert.ok(
            result2000.results.size > result500.results.size ||
            result2000.tracker.mass.getBookkeeping().pending < result500.tracker.mass.getBookkeeping().pending,
            'Resumed search must produce more results or lower pending mass than the first run'
        );

        // Superset check: every result from the first run must survive in the resumed run
        for (const key of result500.results.keys()) {
            assert.ok(
                result2000.results.has(key),
                `Resumed results must be a superset of first run (missing combo key ${key})`
            );
        }
    });

    // ── Test B: Progressive refinement improves accuracy ─────────────────────
    //
    // NOTE: Two separate engines are used to prevent the coarse stats-cache result
    // from short-circuiting the deep run. The test validates that a tighter threshold
    // (0.0001) drives genuinely lower pending mass than a coarser one (0.01) for the
    // same input, independent of cache sharing.
    // NOTE: limit is no longer in the combo cache key (see KeyUtils.getPackedKey),
    // so cross-tier combo cache sharing is now correct; this test intentionally avoids
    // it to keep the assertion clean.

    it('progressive refinement improves accuracy (decreases pending mass)', async () => {
        // Coarse engine: threshold=0.01 — search stops when queue-top prob < 0.001
        EngineFactory.clearCaches();
        const coarseEngine = EngineFactory.create(DATA, '1.21');
        const coarseResult = await coarseEngine.calculate('sword', 30, 'diamond', {
            threshold: 0.01,
            resultsLimit: 1000
        });

        // Deep engine: threshold=0.0001 — search stops when queue-top prob < 0.00001,
        // exploring far more of the probability mass before stopping.
        // A fresh engine ensures the stats cache from the coarse run doesn't interfere.
        EngineFactory.clearCaches();
        const deepEngine = EngineFactory.create(DATA, '1.21');
        const deepResult = await deepEngine.calculate('sword', 30, 'diamond', {
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
        const engine = EngineFactory.create(DATA, '1.21');

        // First call: computes stats and stores them in the stats cache.
        const result1 = await engine.calculate('sword', 30, 'diamond', { threshold: 0.001, resultsLimit: 1000 });

        // Second call with identical params: stats cache hit, returns the same object.
        const result2 = await engine.calculate('sword', 30, 'diamond', { threshold: 0.001, resultsLimit: 1000 });

        assert.strictEqual(result1, result2,
            'Second getFullStats call with same params should return the exact same cached object');
    });

    // ── Test E: Cross-tier resumption through combo cache ───────────────────
    //
    // Same engine: coarse run populates comboCache, then only statsCache is cleared.
    // Deep run must resume from the cached coarse frontiers (not start from scratch),
    // producing strictly higher accuracy than the coarse run.

    it('cross-tier combo cache: deep run resumes from coarse frontier', async () => {
        EngineFactory.clearCaches();
        const engine = EngineFactory.create(DATA, '1.21');

        // Coarse pass: populates both statsCache and comboCache.
        const coarseResult = await engine.calculate('sword', 30, 'diamond', {
            threshold: 0.01,
            resultsLimit: 1000
        });

        // Clear only the statsCache; comboCache retains the coarse frontiers.
        engine.resetStatsCache();

        // Deep pass: statsCache miss forces recomputation, but comboCache hit
        // lets each modLevel search resume from the already-explored coarse frontier.
        const deepResult = await engine.calculate('sword', 30, 'diamond', {
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

    it('tiered produces same final result as sequential getFullStats calls', async () => {
        const engine = EngineFactory.create(DATA, '1.21');

        // Ultra run first: produces low-uncertainty stats, cached at K_stats.
        // The stats key excludes limit and threshold, so K_stats is the same
        // for any config on the same (cat, mat, xp, guaranteed) tuple.
        const ultraResult = await engine.calculate('sword', 30, 'diamond', {
            threshold: 0.00001,
            maxIterations: 200
        });

        // Coarse run: looks up the same K_stats → immediate stats cache hit.
        // Returns the already-cached ultra result without recomputing.
        const coarseResult = await engine.calculate('sword', 30, 'diamond', {
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


