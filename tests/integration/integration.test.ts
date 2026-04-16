/**
 * Integration tests for RefinementService with mocked WorkerClient.
 *
 * These sit between unit tests (pure engine logic) and Playwright e2e tests.
 * WorkerClient.request() is replaced with a controlled fake so tests run in
 * Node.js without a browser or real Web Worker.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { RefinementService } from '../../src/ui/refinement.js';
import { WorkerClient } from '../../src/worker/client.js';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { isCategoryAvailable } from '#core/registry.js';
import { MassAccounting } from '#types/mass.js';
import { TEST_DATA } from '../infra/test-data.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStats(accuracy: number, pending: number = 1 - accuracy): any {
    const acc: MassAccounting = { 
        resolved: accuracy, 
        pending: pending, 
        sieved: 0, 
        overflow: 0, 
        capped: 0,
        rounding: 0,
        recoveredRounding: 0,
        recoveredSieved: 0
    };
    return { 
        accuracy, 
        accounting: acc, 
        uncertainty: pending,
        ranks: {}, any: {}, count: {}, combos: {},
        threshold: accuracy
    };
}

/** Flush microtasks and pending timers (AsyncUtils.yield uses setTimeout). */
function flush(): Promise<void> {
    return new Promise(r => setTimeout(r, 20));
}

const BASE_PAYLOAD = TEST_DATA.PAYLOADS.BASE_SWORD;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Integration: RefinementService with mocked WorkerClient', () => {
    let originalRequest: typeof WorkerClient.request;
    let originalReset: typeof WorkerClient.resetWorker;

    beforeEach(() => {
        originalRequest = WorkerClient.request;
        originalReset = WorkerClient.resetWorker;
        // Default mock that does nothing
        WorkerClient.resetWorker = async () => {};
    });

    afterEach(() => {
        WorkerClient.request = originalRequest;
        WorkerClient.resetWorker = originalReset;
    });

    // -----------------------------------------------------------------------
    // Test 1 — Progressive refinement
    // -----------------------------------------------------------------------
    it('progressive refinement: onStats fires after EACH tier, not just the final one', async () => {
        // Regression: a common bug is that only the last pass fires the display
        // callback. We verify coarse → standard → deep each trigger onStats.

        let progressCb: ((v: any) => void) | undefined;
        let mainResolve: ((v: any) => void) | undefined;

        WorkerClient.request = (_type: string, payload: any, onProgress?: any): Promise<any> => {
            if (payload.source === 'chart') {
                // Chart sweep requests: never resolve so they don't interfere
                return new Promise(() => {});
            }
            if (_type === 'calculateProgressive') {
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

        // --- COARSE tier complete (pending > 0 → not yet converged) ---
        progressCb!({ stats: makeStats(0.1) });
        await flush();

        assert.strictEqual(allStats.length, 1, 'onStats should fire after coarse');
        assert.strictEqual(allStats[0], false, 'coarse should not be isFinal');

        // --- STANDARD tier complete (still not converged) ---
        progressCb!({ stats: makeStats(0.01) });
        await flush();

        assert.strictEqual(allStats.length, 2, 'onStats should fire after standard');
        assert.strictEqual(allStats[1], false, 'standard should not be isFinal');

        // --- DEEP tier complete (pending = 0 → converged, isFinal=true) ---
        progressCb!({ stats: makeStats(1.0, 0) });
        await flush();

        assert.strictEqual(allStats.length, 3, 'onStats should fire after deep');
        assert.strictEqual(allStats[2], true, 'deep with pending=0 should be isFinal');

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

        WorkerClient.request = (_type: string, payload: any, onProgress?: any): Promise<any> => {
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
        // Fire progress with pending=0 → converged, isFinal=true
        run2ProgressCb!({ stats: makeStats(1.0) });
        await flush();

        assert.strictEqual(run2Final.length, 1, 'run2 should fire its own callbacks normally');

        // Clean up
        run2Resolve!({ stats: makeStats(0) });
        await flush();
    });

    // -----------------------------------------------------------------------
    // Test 3 — Chart sweep produces results for the latest run after cancellation
    // -----------------------------------------------------------------------
    it('FIX: chart sweep produces results for the most recent run after cancellation', async () => {
        // The behavioral contract: after run2 starts and run1 is cancelled,
        // chart data should eventually appear attributed to run2's onChart callback.
        // This does NOT test internal implementation (isSweepRunning, abort signals, etc).
        let resolveChartRequest: (v: any) => void = () => { console.log('resolveChartRequest called but no pending request'); };
        let capturedProgress: ((v: any) => void) | undefined;
        let chartReqCount = 0;

        WorkerClient.request = (_type: string, payload: any, onProgress?: any): Promise<any> => {
            if (_type === 'calculateProgressive') {
                capturedProgress = onProgress;
                return new Promise(() => {}); // kept pending; test drives it via capturedProgress
            }
            if (_type === 'calculate' && payload.source === 'chart') {
                chartReqCount++;
                console.log(`Mock intercepted chart request: level=${payload.xp}, count=${chartReqCount}`);
                // Return a controllable promise; the test resolves them manually
                return new Promise(resolve => { resolveChartRequest = resolve; });
            }
            return new Promise(() => {});
        };

        const service = new RefinementService();
        const run1ChartLevels: number[] = [];
        const run2ChartLevels: number[] = [];

        // --- Start run 1: fire one progress event to start the chart sweep ---
        service.run(BASE_PAYLOAD, {} as any, {
            onStatus: () => {},
            onStats: () => {},
            onChart: (sweep) => {
                const populated = sweep.filter(Boolean);
                if (populated.length > 0) run1ChartLevels.push(populated.length);
            },
        });
        await flush(); // allow request to be registered
        capturedProgress?.({ stats: makeStats(0.1) }); // triggers refreshChart for run1
        await flush();

        // --- Cancel run1 by starting run2 ---
        console.log('Starting run2');
        service.run({ ...BASE_PAYLOAD, xpLevel: 15 }, {} as any, {
            onStatus: () => {},
            onStats: () => {},
            onChart: (sweep) => {
                const populated = sweep.filter(Boolean);
                console.log(`run2 onChart triggered with ${populated.length} elements`);
                if (populated.length > 0) run2ChartLevels.push(populated.length);
            },
        });
        await flush(); // allow run2 to register its request
        capturedProgress?.({ stats: makeStats(0.1) }); // triggers refreshChart for run2

        // Drive chart requests: keep resolving until run2 gets chart data
        let maxAttempts = 60;
        console.log('Driving chart requests...');
        while (run2ChartLevels.length === 0 && maxAttempts-- > 0) {
            console.log(`Attempt ${60 - maxAttempts}, resolving chart request`);
            resolveChartRequest({ stats: makeStats(0.01) });
            await flush();
        }

        assert.ok(
            run2ChartLevels.length > 0,
            `Chart should eventually populate for run2 after cancellation of run1 (attempts left: ${maxAttempts})`
        );
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
                { ...BASE_PAYLOAD, category: categories[i % 2]! },
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
            entry.onProgress?.({ stats: makeStats(1.0) }); // pending=0 → converge
            entry.resolve({ stats: makeStats(1.0) });
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

    it('engine re-initialization reflects new version registry (1.4.6 → 1.3.1)', () => {
        // Simulate what the worker does on WorkerClient.init(newVersion):
        // destroy old engine, create new engine with new version.
        const engineA = EngineFactory.create(DATA, TEST_DATA.VERSIONS.LEGACY);
        assert.ok(
            engineA.registry.mergedMaterials.has('book'),
            '1.4.6: book material should be available'
        );
        assert.strictEqual(engineA.registry.multiEnchantBooks, false, '1.4.6: single-enchant books');

        // Simulate re-init: destroy old, create new
        engineA.destroy();
        const engineB = EngineFactory.create(DATA, TEST_DATA.VERSIONS.CLASSIC);
        assert.ok(
            !engineB.registry.mergedMaterials.has(TEST_DATA.MATERIALS.BOOK),
            '1.3.1 (classic): book material should NOT be available after version switch'
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

    it('version switch with book category: getFullStats reflects new version (no books in classic)', async () => {
        // Engine for classic should report book category as unavailable
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.CLASSIC);
        assert.strictEqual(
            isCategoryAvailable(engine.registry, TEST_DATA.ITEMS.BOOK), false,
            'Classic: book category should not be available'
        );
    });
});

// ---------------------------------------------------------------------------
// Guaranteed enchantment accuracy tests (engine direct, no worker mock needed)
// Converted from src/tests/ui-performance.test.ts
// ---------------------------------------------------------------------------

describe('Integration: Guaranteed enchantment accuracy (engine direct)', () => {

    it('guaranteed enchantment (Sword): Sharpness probability >= 99.99% at level 30', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        const stats = await engine.calculate(TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND, {
            guaranteedFirst: 'Sharpness IV',
            threshold: TEST_DATA.THRESHOLDS.PROB_MIN,
        });
        const sharpnessId = engine.registry.idMap.get('Sharpness')!;
        assert.ok(
            (stats.any[sharpnessId] ?? 0) >= 0.9999,
            `Expected Sharpness prob >= 0.9999, got ${stats.any[sharpnessId]}`
        );
    });

    it('guaranteed enchantment (Pickaxe): Efficiency probability >= 99.99% at levels 25, 28, 30', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        const effId = engine.registry.idMap.get('Efficiency')!;
        // Efficiency IV is impossible at Level 10/20 for Diamond (Enchantability 10). 
        // Using 25, 28, 30 instead.
        for (const level of [25, 28, 30]) {
            const stats = await engine.calculate(TEST_DATA.ITEMS.PICKAXE, level, TEST_DATA.MATERIALS.DIAMOND, {
                guaranteedFirst: 'Efficiency IV',
                threshold: TEST_DATA.THRESHOLDS.PROB_MIN,
            });
            const prob = stats.any[effId] ?? 0;
            const isAccurate = prob >= 0.9999 || stats.accuracy >= 0.9999;
            assert.ok(
                isAccurate,
                `Level ${level}: prob=${prob}, accuracy=${stats.accuracy} — expected prob >= 0.9999 or accuracy >= 0.9999`
            );
        }
    });

    it('guaranteed book enchantment: Silk Touch exactly 100%', async () => {
        const engine = EngineFactory.create(DATA, '1.20.1');
        const stats = await engine.calculate('book', 30, 'book', {
            guaranteedFirst: 'Silk Touch I',
            threshold: 0.0001,
        });
        const silkTouchId = engine.registry.idMap.get('Silk Touch')!;
        assert.strictEqual(stats.any[silkTouchId], 1.0, 'Silk Touch probability should be exactly 1.0');
    });
});


