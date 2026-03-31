/**
 * Integration tests for RefinementService chart sweep behavior.
 * Converted from src/tests/ui-chart.test.ts — no browser, no DOM required.
 *
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

/** Flush pending macrotasks (AsyncUtils.yield uses setTimeout 0). */
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

describe('Integration: Chart sweep with mocked WorkerClient', () => {
    let originalRequest: typeof WorkerClient.request;

    beforeEach(() => {
        originalRequest = WorkerClient.request;
    });

    afterEach(() => {
        WorkerClient.request = originalRequest;
    });

    // -----------------------------------------------------------------------
    // Test 1 — Sequential chart sweep
    // -----------------------------------------------------------------------
    it('sequential chart sweep: levels populate 1→30 in order', async () => {
        const mainQueue: Array<(v: any) => void> = [];

        WorkerClient.request = (_type: string, payload: any): Promise<any> => {
            if (payload.source === 'chart') {
                // Resolve immediately with dummy stats
                return Promise.resolve({ stats: makeStats(0.01) });
            }
            return new Promise(resolve => mainQueue.push(resolve));
        };

        const service = new RefinementService();
        let lastSweep: (any | null)[] = new Array(30).fill(null);
        const chartPopulatedLog: number[] = [];

        service.run(BASE_PAYLOAD, null as any, {
            onStatus: () => {},
            onStats: () => {},
            onChart: (sweep) => {
                // Detect which level index was just updated by comparing against last state.
                // Each onChart call updates exactly one new entry (the just-completed level).
                const updatedIdx = sweep.findIndex((s, i) => s !== lastSweep[i]);
                if (updatedIdx !== -1) {
                    chartPopulatedLog.push(updatedIdx + 1); // convert to 1-based level
                }
                lastSweep = [...sweep]; // shallow copy so next comparison works
            },
        });

        // Resolve coarse main pass (not converged → refinement continues in background)
        assert.strictEqual(mainQueue.length, 1, 'coarse request should be queued synchronously');
        mainQueue.shift()!({ stats: makeStats(0.1) });

        // Wait for the coarse chart sweep to populate all 30 levels
        for (let i = 0; i < 5; i++) await flush();

        // Verify that a linear 1→30 trace exists in the log
        let foundLinear30 = false;
        let lastVal = 0;
        for (const val of chartPopulatedLog) {
            if (val === lastVal + 1) {
                lastVal = val;
            } else if (val === 1) {
                lastVal = 1;
            }
            if (lastVal === 30) {
                foundLinear30 = true;
                break;
            }
        }

        assert.ok(
            foundLinear30,
            `Expected a linear 1→30 trace in chart updates. Captured log: [${chartPopulatedLog}]`
        );
    });

    // -----------------------------------------------------------------------
    // Test 2 — Multi-pass refinement
    // -----------------------------------------------------------------------
    it('multi-pass refinement: at least 2 full sweeps complete', async () => {
        const mainQueue: Array<(v: any) => void> = [];

        WorkerClient.request = (_type: string, payload: any): Promise<any> => {
            if (payload.source === 'chart') {
                return Promise.resolve({ stats: makeStats(0.01) });
            }
            return new Promise(resolve => mainQueue.push(resolve));
        };

        // Use 'book' for highest complexity (matches original Playwright test)
        const bookPayload = { ...BASE_PAYLOAD, category: 'book', material: 'book' };
        const service = new RefinementService();
        let lastSweep: (any | null)[] = new Array(30).fill(null);
        const chartPopulatedLog: number[] = [];

        service.run(bookPayload, null as any, {
            onStatus: () => {},
            onStats: () => {},
            onChart: (sweep) => {
                const updatedIdx = sweep.findIndex((s, i) => s !== lastSweep[i]);
                if (updatedIdx !== -1) {
                    chartPopulatedLog.push(updatedIdx + 1);
                }
                lastSweep = [...sweep];
            },
        });

        // Resolve coarse main pass (not converged)
        assert.strictEqual(mainQueue.length, 1, 'coarse request pending');
        mainQueue.shift()!({ stats: makeStats(0.1) });

        // Let coarse return and chart sweep start; standard request gets queued
        await flush();

        // Resolve standard main pass while chart sweep may still be running.
        // This updates targetThreshold so the sweep loops (or a second sweep starts).
        assert.ok(mainQueue.length >= 1, 'standard request should be pending after coarse');
        mainQueue.shift()!({ stats: makeStats(0.01) });

        // Allow time for both sweeps (2 × 30 levels × setTimeout 0)
        for (let i = 0; i < 8; i++) await flush();

        // Count complete sequential 1→30 sweeps in the log
        let completeSweeps = 0;
        let lastVal = 0;
        for (const val of chartPopulatedLog) {
            if (val === lastVal + 1) {
                lastVal = val;
                if (lastVal === 30) {
                    completeSweeps++;
                    lastVal = 0;
                }
            } else if (val === 1) {
                lastVal = 1;
            }
        }

        assert.ok(
            completeSweeps >= 2,
            `Expected >= 2 complete 1→30 sweeps. Got ${completeSweeps}. Log (first 70): [${chartPopulatedLog.slice(0, 70)}]`
        );
    });

    // -----------------------------------------------------------------------
    // Test 3 — Accuracy improvement between coarse and final passes
    // -----------------------------------------------------------------------
    it('accuracy improves between coarse and final passes', async () => {
        const mainQueue: Array<(v: any) => void> = [];

        // Simulate accuracy improvement: finer threshold returns lower uncertainty
        // sword coarse threshold = 0.01, standard threshold = 0.0005
        WorkerClient.request = (_type: string, payload: any): Promise<any> => {
            if (payload.source === 'chart') {
                const threshold = payload.threshold as number;
                const uncertainty = threshold >= 0.005 ? 0.1 : 0.001;
                return Promise.resolve({ stats: makeStats(uncertainty) });
            }
            return new Promise(resolve => mainQueue.push(resolve));
        };

        const service = new RefinementService();
        let lastSweep: (any | null)[] = new Array(30).fill(null);
        let coarseSweepSnap: { uncertainty: number }[] | null = null;
        let finalSweepSnap: { uncertainty: number }[] | null = null;

        service.run(BASE_PAYLOAD, null as any, {
            onStatus: () => {},
            onStats: () => {},
            onChart: (sweep) => {
                const updatedIdx = sweep.findIndex((s, i) => s !== lastSweep[i]);
                // Capture a snapshot whenever level 30 (index 29) is the just-updated entry,
                // i.e., a full sweep just finished.
                if (updatedIdx === 29) {
                    const snap = sweep.map(s => ({ uncertainty: s?.s?.uncertainty ?? -1 }));
                    if (coarseSweepSnap === null) {
                        coarseSweepSnap = snap;
                    } else {
                        finalSweepSnap = snap;
                    }
                }
                lastSweep = [...sweep];
            },
        });

        // Resolve coarse main pass → first chart sweep with coarse threshold
        mainQueue.shift()!({ stats: makeStats(0.1) });
        await flush();

        // Resolve standard main pass → second chart sweep with finer threshold
        assert.ok(mainQueue.length >= 1, 'standard request should be pending');
        mainQueue.shift()!({ stats: makeStats(0.01) });

        // Wait for both sweeps to complete
        for (let i = 0; i < 8; i++) await flush();

        assert.ok(coarseSweepSnap !== null, 'Should have captured a coarse sweep snapshot');
        assert.ok(finalSweepSnap !== null, 'Should have captured a final sweep snapshot (requires >= 2 sweeps)');

        // At least some levels should show reduced uncertainty in the final pass
        let refinedLevels = 0;
        for (let i = 0; i < 30; i++) {
            if (finalSweepSnap![i].uncertainty < coarseSweepSnap![i].uncertainty - 0.00001) {
                refinedLevels++;
            }
        }
        assert.ok(
            refinedLevels > 0,
            `Expected the final sweep to reduce uncertainty for at least one level. ` +
            `Coarse[0]: ${coarseSweepSnap![0].uncertainty}, Final[0]: ${finalSweepSnap![0].uncertainty}`
        );
    });
});
