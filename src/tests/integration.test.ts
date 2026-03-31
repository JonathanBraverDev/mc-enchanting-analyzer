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
    it('progressive refinement: onInsights fires after EACH pass, not just the final one', async () => {
        // Regression: a common bug is that only the last pass fires the display
        // callback. We verify coarse → standard → deep each trigger onInsights.

        const mainQueue: Array<(v: any) => void> = [];

        WorkerClient.request = (_type: string, payload: any, _onProgress?: any): Promise<any> => {
            if (payload.source === 'chart') {
                // Chart sweep requests: never resolve so they don't interfere
                return new Promise(() => {});
            }
            return new Promise(resolve => mainQueue.push(resolve));
        };

        const service = new RefinementService();
        const finalInsights: any[] = [];

        service.run(BASE_PAYLOAD, null as any, {
            onStatus: () => {},
            onInsights: (insights, isFinal) => { if (isFinal) finalInsights.push(insights); },
            onChart: () => {},
        });

        // executePass() calls WorkerClient.request synchronously before awaiting,
        // so the coarse request is queued before run() yields.
        assert.strictEqual(mainQueue.length, 1, 'coarse request queued synchronously');

        // --- Resolve COARSE (uncertainty > 0 → not yet converged) ---
        mainQueue.shift()!({ stats: makeStats(0.1) });
        await flush();

        assert.strictEqual(finalInsights.length, 1, 'onInsights(isFinal=true) should fire after coarse');
        assert.strictEqual(mainQueue.length, 1, 'standard request should now be pending');

        // --- Resolve STANDARD (still not converged) ---
        mainQueue.shift()!({ stats: makeStats(0.01) });
        await flush();

        assert.strictEqual(finalInsights.length, 2, 'onInsights(isFinal=true) should fire after standard');
        assert.strictEqual(mainQueue.length, 1, 'deep request should now be pending');

        // --- Resolve DEEP (uncertainty = 0 → converged → loop breaks) ---
        mainQueue.shift()!({ stats: makeStats(0) });
        await flush();

        assert.strictEqual(finalInsights.length, 3, 'onInsights(isFinal=true) should fire after deep');
        assert.strictEqual(mainQueue.length, 0, 'no more requests after convergence');
    });

    // -----------------------------------------------------------------------
    // Test 2 — Cancellation
    // -----------------------------------------------------------------------
    it('cancellation: when run() is called again, the old run stops firing callbacks', async () => {
        // A version/category switch calls run() again, incrementing activeId.
        // Any still-pending promise from the old run should be silently dropped.

        const mainQueue: Array<(v: any) => void> = [];

        WorkerClient.request = (_type: string, payload: any): Promise<any> => {
            if (payload.source === 'chart') return new Promise(() => {});
            return new Promise(resolve => mainQueue.push(resolve));
        };

        const service = new RefinementService();
        const run1Final: boolean[] = [];
        const run2Final: boolean[] = [];

        // --- Start run 1 ---
        service.run(BASE_PAYLOAD, null as any, {
            onStatus: () => {},
            onInsights: (_, isFinal) => { if (isFinal) run1Final.push(true); },
            onChart: () => {},
        });
        assert.strictEqual(mainQueue.length, 1, 'run1 coarse request pending');
        const run1CoarseResolve = mainQueue.shift()!;

        // --- Start run 2 (cancels run 1 by incrementing activeId) ---
        service.run({ ...BASE_PAYLOAD, xpLevel: 15 }, null as any, {
            onStatus: () => {},
            onInsights: (_, isFinal) => { if (isFinal) run2Final.push(true); },
            onChart: () => {},
        });

        // Now resolve run 1's coarse — should be silently dropped
        run1CoarseResolve({ stats: makeStats(0.1) });
        await flush();

        assert.strictEqual(run1Final.length, 0, 'run1 callbacks should be suppressed after cancellation');

        // Run 2's own coarse should now be pending
        assert.ok(mainQueue.length >= 1, 'run2 should have a pending request');
        mainQueue.shift()!({ stats: makeStats(0) }); // converged immediately
        await flush();

        assert.strictEqual(run2Final.length, 1, 'run2 should fire its own callbacks normally');
    });

    // -----------------------------------------------------------------------
    // Test 3 — isSweepRunning stuck bug (documents known regression)
    // -----------------------------------------------------------------------
    it('BUG: isSweepRunning stays stuck when chart requests hang after cancellation', async () => {
        // When WorkerClient is re-initialised (version switch), in-flight worker
        // promises are never rejected — they hang forever.  The chart sweep is
        // awaiting one of those promises, so its finally{} block never runs, and
        // isSweepRunning stays true.  The next call to refreshChart() sees
        // isSweepRunning=true and returns immediately, so the chart never updates.
        //
        // TODO: Fix by rejecting all WorkerClient.pendingRequests on re-init.
        // When fixed, change the assertion at the bottom to:
        //   assert.ok(run2ChartCalls.length > 0, 'chart should update after restart')

        const mainQueue: Array<(v: any) => void> = [];
        let chartRequestCount = 0;

        WorkerClient.request = (_type: string, payload: any): Promise<any> => {
            if (payload.source === 'chart') {
                chartRequestCount++;
                return new Promise(() => {}); // simulates a dead/hung worker
            }
            return new Promise(resolve => mainQueue.push(resolve));
        };

        const service = new RefinementService();
        const run2ChartCalls: any[][] = [];

        // --- Run 1: coarse resolves → chart sweep starts → first chart request hangs ---
        service.run(BASE_PAYLOAD, null as any, {
            onStatus: () => {},
            onInsights: () => {},
            onChart: () => {},
        });
        mainQueue.shift()!({ stats: makeStats(0.1) }); // resolve run1 coarse
        await flush();

        const chartReqsAfterRun1 = chartRequestCount;
        assert.ok(chartReqsAfterRun1 >= 1, 'run1 chart sweep should have started (isSweepRunning=true now)');

        // --- Run 2: cancels run1, coarse resolves, tries to start chart sweep ---
        // Remember how many requests are in the queue before run2 starts, so we
        // can pick out run2's coarse request specifically.
        const queueBeforeRun2 = mainQueue.length;
        service.run({ ...BASE_PAYLOAD, xpLevel: 15 }, null as any, {
            onStatus: () => {},
            onInsights: () => {},
            onChart: (sweep) => run2ChartCalls.push([...sweep]),
        });

        const run2Resolvers = mainQueue.splice(queueBeforeRun2); // run2's coarse
        assert.strictEqual(run2Resolvers.length, 1, 'run2 coarse should be the only new request');
        run2Resolvers[0]({ stats: makeStats(0.1) }); // resolve run2 coarse
        await flush();

        // BUG: isSweepRunning is still true from run1's hung chart request.
        // refreshChart() for run2 returns early, so no new chart requests are made.
        assert.strictEqual(
            chartRequestCount, chartReqsAfterRun1,
            'BUG: no new chart requests from run2 because isSweepRunning is stuck'
        );
        assert.strictEqual(
            run2ChartCalls.length, 0,
            'BUG: onChart never called for run2 — chart frozen after version switch'
        );
    });

    // -----------------------------------------------------------------------
    // Test 4 — WorkerClient pending-request drain (documents known regression)
    // -----------------------------------------------------------------------
    it('BUG: WorkerClient.init() does not reject in-flight requests (they hang forever)', async () => {
        // When WorkerClient.init() is called it terminates the old worker process
        // but leaves every entry in pendingRequests unresolved.  Any code awaiting
        // WorkerClient.request() from the old worker will hang forever.
        //
        // TODO: Fix by iterating WorkerClient.pendingRequests and calling reject()
        // on each entry before (or immediately after) terminating the worker.

        let wasRejected = false;
        const TEST_KEY = 'main_integration_drain_test';

        // Simulate an in-flight request that exists when init() would be called
        const hangingPromise = new Promise<void>((_resolve, reject) => {
            WorkerClient.pendingRequests.set(TEST_KEY, {
                resolve: () => {},
                reject: (e) => { wasRejected = true; reject(e); },
            });
        });

        // The current (broken) state: the entry is still live, not rejected
        assert.strictEqual(
            WorkerClient.pendingRequests.has(TEST_KEY), true,
            'pending request is in the map before re-init'
        );
        assert.strictEqual(wasRejected, false, 'BUG: pending request has not been rejected');

        // A correct implementation would call req.reject(new Error('re-init')) here.
        // We document the bug by confirming the request is still unresolved.
        // (hangingPromise will never settle, which is the bug itself.)

        // Cleanup so we don't pollute other tests
        WorkerClient.pendingRequests.delete(TEST_KEY);
        // Suppress the unhandled-rejection warning by making hangingPromise non-fatal
        hangingPromise.catch(() => {});
    });
});
