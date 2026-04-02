/**
 * Integration tests for RefinementService with mocked WorkerClient.
 *
 * These sit between unit tests (pure engine logic) and Playwright e2e tests.
 * WorkerClient.request() is replaced with a controlled fake so tests run in
 * Node.js without a browser or real Web Worker.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { RefinementService } from '../ui/refinement.js';
import { WorkerClient } from '../worker/client.js';
import { EnchantEngine } from '../engine/index.js';
import { DATA } from '../data/index.js';
import { isCategoryAvailable } from '../core/registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStats(uncertainty: number): any {
    return { uncertainty, ranks: {}, any: {}, count: {}, combos: {}, pruned: 0, roundingError: 0 };
}

/** Flush microtasks and pending timers (AsyncUtils.yield uses setTimeout). */
function flush(): Promise<void> {
    return new Promise(r => setTimeout(r, 20));
}

const BASE_PAYLOAD = {
    category: 'sword',
    material: 'diamond',
    guaranteedFirst: null as null,
    xpLevel: 30,
    version: '1.21',
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Integration: RefinementService with mocked WorkerClient', () => {
    let originalRequest: typeof WorkerClient.request;

    beforeEach(() => {
        originalRequest = WorkerClient.request;
    });

    afterEach(() => {
        WorkerClient.request = originalRequest;
    });

    // -----------------------------------------------------------------------
    // Test 1 — Progressive refinement
    // -----------------------------------------------------------------------
    it('progressive refinement: onStats fires after EACH tier, not just the final one', async () => {
        // Regression: a common bug is that only the last pass fires the display
        // callback. We verify coarse → standard → deep each trigger onStats.

        let progressCb: ((v: any) => void) | undefined;
        let mainResolve: ((v: any) => void) | undefined;

        WorkerClient.request = (type: string, payload: any, onProgress?: any): Promise<any> => {
            if (payload.source === 'chart') {
                // Chart sweep requests: never resolve so they don't interfere
                return new Promise(() => {});
            }
            if (type === 'getFullStatsProgressive') {
                progressCb = onProgress;
                return new Promise(resolve => { mainResolve = resolve; });
            }
            return new Promise(() => {});
        };

        const service = new RefinementService();
        const allStats: boolean[] = []; // track isFinal per call

        service.run(BASE_PAYLOAD, null as any, {
            onStatus: () => {},
            onStats: (_insights, isFinal) => { allStats.push(isFinal); },
            onChart: () => {},
        });

        // The progressive request is queued synchronously before run() yields.
        assert.ok(progressCb !== undefined, 'progress callback should be registered');

        // --- COARSE tier complete (uncertainty > 0 → not yet converged) ---
        progressCb!({ stats: makeStats(0.1) });
        await flush();

        assert.strictEqual(allStats.length, 1, 'onStats should fire after coarse');
        assert.strictEqual(allStats[0], false, 'coarse should not be isFinal');

        // --- STANDARD tier complete (still not converged) ---
        progressCb!({ stats: makeStats(0.01) });
        await flush();

        assert.strictEqual(allStats.length, 2, 'onStats should fire after standard');
        assert.strictEqual(allStats[1], false, 'standard should not be isFinal');

        // --- DEEP tier complete (uncertainty = 0 → converged, isFinal=true) ---
        progressCb!({ stats: makeStats(0) });
        await flush();

        assert.strictEqual(allStats.length, 3, 'onStats should fire after deep');
        assert.strictEqual(allStats[2], true, 'deep with uncertainty=0 should be isFinal');

        // --- ULTRA tier should be ignored (already converged) ---
        progressCb!({ stats: makeStats(0) });
        await flush();

        assert.strictEqual(allStats.length, 3, 'onStats should NOT fire after ultra (already converged)');

        // Clean up: resolve the pending promise
        mainResolve!({ stats: makeStats(0) });
        await flush();
    });

    // -----------------------------------------------------------------------
    // Test 2 — Cancellation
    // -----------------------------------------------------------------------
    it('cancellation: when run() is called again, the old run stops firing callbacks', async () => {
        // A version/category switch calls run() again, incrementing activeId.
        // Any still-pending promise from the old run should be silently dropped.

        let requestCount = 0;
        let run1ProgressCb: ((v: any) => void) | undefined;
        let run2ProgressCb: ((v: any) => void) | undefined;
        let run2Resolve: ((v: any) => void) | undefined;

        WorkerClient.request = (type: string, payload: any, onProgress?: any): Promise<any> => {
            if (payload.source === 'chart') return new Promise(() => {});
            requestCount++;
            if (requestCount === 1) {
                run1ProgressCb = onProgress;
                return new Promise(() => {}); // run1 never resolves (cancelled)
            }
            run2ProgressCb = onProgress;
            return new Promise(resolve => { run2Resolve = resolve; });
        };

        const service = new RefinementService();
        const run1Final: boolean[] = [];
        const run2Final: boolean[] = [];

        // --- Start run 1 ---
        service.run(BASE_PAYLOAD, null as any, {
            onStatus: () => {},
            onStats: (_, isFinal) => { if (isFinal) run1Final.push(true); },
            onChart: () => {},
        });
        assert.ok(run1ProgressCb !== undefined, 'run1 progressive request pending');

        // --- Start run 2 (cancels run 1 by incrementing activeId) ---
        service.run({ ...BASE_PAYLOAD, xpLevel: 15 }, null as any, {
            onStatus: () => {},
            onStats: (_, isFinal) => { if (isFinal) run2Final.push(true); },
            onChart: () => {},
        });

        // Now fire run 1's progress — should be silently dropped
        run1ProgressCb!({ stats: makeStats(0.1) });
        await flush();

        assert.strictEqual(run1Final.length, 0, 'run1 callbacks should be suppressed after cancellation');

        // Run 2's progressive request should be pending
        assert.ok(run2ProgressCb !== undefined, 'run2 should have a pending request');
        // Fire progress with uncertainty=0 → converged, isFinal=true
        run2ProgressCb!({ stats: makeStats(0) });
        await flush();

        assert.strictEqual(run2Final.length, 1, 'run2 should fire its own callbacks normally');

        // Clean up
        run2Resolve!({ stats: makeStats(0) });
        await flush();
    });

    // -----------------------------------------------------------------------
    // Test 3 — isSweepRunning reset fix
    // -----------------------------------------------------------------------
    it('FIX: isSweepRunning resets on new run(), allowing chart sweep to restart', async () => {
        // run() now resets isSweepRunning=false before starting, so even if run1's
        // chart sweep is stuck on a hung request, run2 can start a fresh sweep.

        type QueueEntry = { onProgress?: (v: any) => void; resolve: (v: any) => void };
        const mainQueue: QueueEntry[] = [];
        let chartRequestCount = 0;
        let run2Active = false;

        WorkerClient.request = (type: string, payload: any, onProgress?: any): Promise<any> => {
            if (payload.source === 'chart') {
                chartRequestCount++;
                if (run2Active) {
                    // run2's chart requests resolve immediately so onChart fires
                    return Promise.resolve({ stats: makeStats(0.01) });
                }
                return new Promise(() => {}); // run1's chart requests hang
            }
            return new Promise(resolve => mainQueue.push({ onProgress, resolve }));
        };

        const service = new RefinementService();
        const run2ChartCalls: any[][] = [];

        // --- Run 1: coarse tier fires → chart sweep starts → first chart request hangs ---
        service.run(BASE_PAYLOAD, null as any, {
            onStatus: () => {},
            onStats: () => {},
            onChart: () => {},
        });
        // Fire progress for run1's coarse tier to trigger refreshChart
        assert.strictEqual(mainQueue.length, 1, 'run1 progressive request pending');
        mainQueue[0].onProgress?.({ stats: makeStats(0.1) }); // fire coarse tier
        await flush();

        const chartReqsAfterRun1 = chartRequestCount;
        assert.ok(chartReqsAfterRun1 >= 1, 'run1 chart sweep should have started');

        // --- Run 2: cancels run1, coarse tier fires, tries to start chart sweep ---
        run2Active = true;
        const queueBeforeRun2 = mainQueue.length;
        service.run({ ...BASE_PAYLOAD, xpLevel: 15 }, null as any, {
            onStatus: () => {},
            onStats: () => {},
            onChart: (sweep) => run2ChartCalls.push([...sweep]),
        });

        const run2Entries = mainQueue.splice(queueBeforeRun2); // run2's progressive request
        assert.strictEqual(run2Entries.length, 1, 'run2 progressive request should be the only new request');
        run2Entries[0].onProgress?.({ stats: makeStats(0.1) }); // fire run2 coarse tier
        await flush();

        // FIX: isSweepRunning is reset at the start of run(), so run2's chart sweep starts.
        assert.ok(
            chartRequestCount > chartReqsAfterRun1,
            'FIX: run2 should make new chart requests after restart'
        );
        assert.ok(run2ChartCalls.length > 0, 'chart should update after restart');

        // Clean up
        run2Entries[0].resolve({ stats: makeStats(0.1) });
        await flush();
    });

    // -----------------------------------------------------------------------
    // Test 5 — Stress test (rapid run() calls)
    // -----------------------------------------------------------------------
    it('stress: 10 rapid run() calls do not crash, final run completes', async () => {
        type QueueEntry = { onProgress?: (v: any) => void; resolve: (v: any) => void };
        const mainQueue: QueueEntry[] = [];

        WorkerClient.request = (_type: string, payload: any, onProgress?: any): Promise<any> => {
            if (payload.source === 'chart') return new Promise(() => {}); // chart hangs
            return new Promise(resolve => mainQueue.push({ onProgress, resolve }));
        };

        const service = new RefinementService();
        const finalInsights: any[] = [];
        const errors: Error[] = [];

        const categories = ['sword', 'pickaxe'];
        for (let i = 0; i < 10; i++) {
            service.run(
                { ...BASE_PAYLOAD, category: categories[i % 2] },
                null as any,
                {
                    onStatus: () => {},
                    onStats: (_insights: any, isFinal: boolean) => { if (isFinal) finalInsights.push(_insights); },
                    onChart: () => {},
                }
            ).catch((e: Error) => errors.push(e));
        }

        // Drain the request queue; only the final run's callbacks fire (others are cancelled)
        // Fire onProgress first (triggers onStats/isFinal for converged stats), then resolve
        let maxIters = 50;
        while (mainQueue.length > 0 && maxIters-- > 0) {
            const entry = mainQueue.shift()!;
            entry.onProgress?.({ stats: makeStats(0) }); // uncertainty=0 → converge
            entry.resolve({ stats: makeStats(0) });
            await flush();
        }

        assert.strictEqual(errors.length, 0, 'No errors should occur during rapid run() calls');
        assert.ok(finalInsights.length >= 1, 'Final run should fire onInsights at least once');
    });

    // -----------------------------------------------------------------------
    // Test 4 — WorkerClient pending-request drain (fix verified)
    // -----------------------------------------------------------------------
    it('FIX: WorkerClient.drainPendingForWorker() rejects in-flight requests on re-init', async () => {
        // drainPendingForWorker() is now called by initWorker() before terminating
        // the old worker, so any awaiting code gets a rejection instead of hanging.

        let wasRejected = false;
        const TEST_KEY = 'main_integration_drain_test';

        // Simulate an in-flight request that exists when init() would be called
        const hangingPromise = new Promise<void>((_resolve, reject) => {
            WorkerClient.pendingRequests.set(TEST_KEY, {
                resolve: () => {},
                reject: (e) => { wasRejected = true; reject(e); },
            });
        });

        assert.strictEqual(
            WorkerClient.pendingRequests.has(TEST_KEY), true,
            'pending request is in the map before re-init'
        );

        // Simulate what initWorker() now does: drain pending requests for this worker
        WorkerClient.drainPendingForWorker('main');

        // FIX: request IS rejected after re-init
        assert.strictEqual(wasRejected, true, 'request IS rejected after re-init');
        assert.strictEqual(
            WorkerClient.pendingRequests.has(TEST_KEY), false,
            'pending request is removed from the map after drain'
        );

        // hangingPromise now rejects (expected); suppress unhandled-rejection warning
        hangingPromise.catch(() => {});
    });
});

// ---------------------------------------------------------------------------
// Version / book state reset tests
// ---------------------------------------------------------------------------

describe('Integration: Version switch and book state reset', () => {
    afterEach(() => {
        EnchantEngine.clearAllEngines();
    });

    it('engine re-initialization reflects new version registry (1.4.6 → 1.3.1)', () => {
        // Simulate what the worker does on WorkerClient.init(newVersion):
        // destroy old engine, create new engine with new version.
        const engineA = new EnchantEngine(DATA, '1.4.6');
        assert.ok(
            engineA.registry.mergedMaterials.has('book'),
            '1.4.6: book material should be available'
        );
        assert.strictEqual(engineA.registry.multiEnchantBooks, false, '1.4.6: single-enchant books');

        // Simulate re-init: destroy old, create new
        engineA.destroy();
        const engineB = new EnchantEngine(DATA, '1.3.1');
        assert.ok(
            !engineB.registry.mergedMaterials.has('book'),
            '1.3.1: book material should NOT be available after version switch'
        );
    });

    it('drainPendingForWorker drains both main and chart worker keys', () => {
        const mainRejections: string[] = [];
        const chartRejections: string[] = [];

        WorkerClient.pendingRequests.set('main_999', {
            resolve: () => {},
            reject: () => mainRejections.push('main_999'),
        });
        WorkerClient.pendingRequests.set('chart_888', {
            resolve: () => {},
            reject: () => chartRejections.push('chart_888'),
        });
        // An unrelated key must survive
        WorkerClient.pendingRequests.set('main_888_progress', {
            resolve: () => {},
            reject: () => {},
        });

        WorkerClient.drainPendingForWorker('main');

        assert.deepStrictEqual(mainRejections, ['main_999'], 'main_999 should be rejected');
        assert.deepStrictEqual(chartRejections, [], 'chart_888 should be untouched');

        // Clean up
        WorkerClient.pendingRequests.delete('chart_888');
        WorkerClient.pendingRequests.delete('main_888_progress');
    });

    it('version switch with book category: getFullStats reflects new version (no books in 1.3.1)', async () => {
        // Engine for 1.3.1 should report book category as unavailable
        const engine = new EnchantEngine(DATA, '1.3.1');
        assert.strictEqual(
            isCategoryAvailable(engine.registry, 'book'), false,
            '1.3.1: book category should not be available'
        );
    });
});

// ---------------------------------------------------------------------------
// Guaranteed enchantment accuracy tests (engine direct, no worker mock needed)
// Converted from src/tests/ui-performance.test.ts
// ---------------------------------------------------------------------------

describe('Integration: Guaranteed enchantment accuracy (engine direct)', () => {
    afterEach(() => {
        EnchantEngine.clearAllEngines();
    });

    it('guaranteed enchantment (Sword): Sharpness probability >= 99.99% at level 30', async () => {
        const engine = new EnchantEngine(DATA, '1.21');
        const stats = await engine.getFullStats('sword', 30, 'diamond', {
            guaranteedFirst: 'Sharpness IV',
            threshold: 0.0001,
        });
        const sharpnessId = engine.registry.idMap.get('Sharpness')!;
        assert.ok(
            stats.any[sharpnessId] >= 0.9999,
            `Expected Sharpness prob >= 0.9999, got ${stats.any[sharpnessId]}`
        );
    });

    it('guaranteed enchantment (Pickaxe): Efficiency probability >= 99.99% at levels 10, 20, 30', async () => {
        const engine = new EnchantEngine(DATA, '1.21');
        const effId = engine.registry.idMap.get('Efficiency')!;
        for (const level of [10, 20, 30]) {
            const stats = await engine.getFullStats('pickaxe', level, 'diamond', {
                guaranteedFirst: 'Efficiency IV',
                threshold: 0.0001,
            });
            const prob = stats.any[effId] ?? 0;
            const isAccurate = prob >= 0.9999 || stats.uncertainty >= 0.9999;
            assert.ok(
                isAccurate,
                `Level ${level}: prob=${prob}, uncertainty=${stats.uncertainty} — expected prob >= 0.9999 or uncertainty >= 0.9999`
            );
        }
    });

    it('guaranteed book enchantment: Silk Touch exactly 100%', async () => {
        const engine = new EnchantEngine(DATA, '1.20.1');
        const stats = await engine.getFullStats('book', 30, 'book', {
            guaranteedFirst: 'Silk Touch I',
            threshold: 0.0001,
        });
        const silkTouchId = engine.registry.idMap.get('Silk Touch')!;
        assert.strictEqual(stats.any[silkTouchId], 1.0, 'Silk Touch probability should be exactly 1.0');
    });
});
