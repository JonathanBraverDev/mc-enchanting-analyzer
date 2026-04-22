/**
 * Integration tests for RefinementService chart sweep behavior.
 * Converted from src/tests/ui-chart.test.ts — no browser, no DOM required.
 *
 * WorkerClient.request() is replaced with a controlled fake so tests run in
 * Node.js without a browser or real Web Worker.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MassAccounting } from '#types/mass.js';
import { RefinementService } from '../../src/ui/refinement.js';
import { WorkerClient } from '../../src/worker/client.js';
import { TEST_DATA } from '../infra/test-data.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStats(accuracy: number): any {
    const acc: MassAccounting = { resolved: accuracy, pending: 1 - accuracy, sieved: 0, overflow: 0, capped: 0, rounding: 0, recoveredRounding: 0, recoveredSieved: 0 };
    return { accuracy, accounting: acc, ranks: {}, any: {}, count: {}, combos: {} };
}

/** Flush pending macrotasks (AsyncUtils.yield uses setTimeout 0). */
function flush(): Promise<void> {
    return new Promise(r => setTimeout(r, 20));
}

const BASE_PAYLOAD = TEST_DATA.PAYLOADS.BASE_SWORD;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Integration: Chart sweep with mocked WorkerClient', () => {
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
    // Test 1 — Sequential chart sweep
    // -----------------------------------------------------------------------
    it('sequential chart sweep: levels populate 1→30 in order', async () => {
        type QueueEntry = { onProgress?: (v: any) => void; resolve: (v: any) => void };
        const mainQueue: QueueEntry[] = [];

        WorkerClient.request = (_type: string, payload: any, onProgress?: any): Promise<any> => {
            if (payload.source === 'chart') {
                // Resolve immediately with dummy stats
                return Promise.resolve({ stats: makeStats(0.01) });
            }
            return new Promise(resolve => mainQueue.push({ onProgress, resolve }));
        };

        const service = new RefinementService();
        let lastSweep: (any | null)[] = new Array(30).fill(null);
        const chartPopulatedLog: number[] = [];

        service.run(BASE_PAYLOAD, {} as any, {
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

        // Fire coarse tier progress to trigger refreshChart (not converged)
        assert.strictEqual(mainQueue.length, 1, 'progressive request should be queued synchronously');
        const q0 = mainQueue[0];
        assert.ok(q0 !== undefined);
        q0.onProgress?.({ stats: makeStats(0.1) });

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

        // Clean up
        const q1 = mainQueue[0];
        assert.ok(q1 !== undefined);
        q1.resolve({ stats: makeStats(0.1) });
        await flush();
    });

    // -----------------------------------------------------------------------
    // Test 2 — Multi-pass refinement
    // -----------------------------------------------------------------------
    it('multi-pass refinement: at least 2 full sweeps complete', async () => {
        type QueueEntry = { onProgress?: (v: any) => void; resolve: (v: any) => void };
        const mainQueue: QueueEntry[] = [];

        WorkerClient.request = (_type: string, payload: any, onProgress?: any): Promise<any> => {
            if (payload.source === 'chart') {
                return Promise.resolve({ stats: makeStats(0.01) });
            }
            return new Promise(resolve => mainQueue.push({ onProgress, resolve }));
        };

        // Use 'book' for highest complexity (matches original Playwright test)
        const bookPayload = TEST_DATA.PAYLOADS.MODERN_BOOK;
        const service = new RefinementService();
        let lastSweep: (any | null)[] = new Array(30).fill(null);
        const chartPopulatedLog: number[] = [];

        service.run(bookPayload, {} as any, {
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

        // Fire coarse tier progress (not converged) → first chart sweep starts
        assert.strictEqual(mainQueue.length, 1, 'progressive request pending');
        const q2 = mainQueue[0];
        assert.ok(q2 !== undefined);
        q2.onProgress?.({ stats: makeStats(0.1) });

        // Let coarse chart sweep start
        await flush();

        // Fire standard tier progress while chart sweep may still be running.
        // This updates targetThreshold so the sweep loops (or a second sweep starts).
        const q2b = mainQueue[0];
        assert.ok(q2b !== undefined);
        q2b.onProgress?.({ stats: makeStats(0.01) });

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

        // Clean up
        const q3 = mainQueue[0];
        assert.ok(q3 !== undefined);
        q3.resolve({ stats: makeStats(0.01) });
        await flush();
    });

    // -----------------------------------------------------------------------
    // Test 3 — Accuracy improvement between coarse and final passes
    // -----------------------------------------------------------------------
    it('accuracy improves between coarse and final passes', async () => {
        type QueueEntry = { onProgress?: (v: any) => void; resolve: (v: any) => void };
        const mainQueue: QueueEntry[] = [];

        WorkerClient.request = (_type: string, payload: any, onProgress?: any): Promise<any> => {
            if (payload.source === 'chart') {
                const threshold = payload.threshold as number;
                const accuracy = threshold >= 0.005 ? 0.9 : 0.999;
                return Promise.resolve({ stats: makeStats(accuracy) });
            }
            return new Promise(resolve => mainQueue.push({ onProgress, resolve }));
        };

        const service = new RefinementService();
        let lastSweep: (any | null)[] = new Array(30).fill(null);
        let coarseSweepSnap: { accuracy: number }[] | null = null;
        let finalSweepSnap: { accuracy: number }[] | null = null;

        service.run(BASE_PAYLOAD, {} as any, {
            onStatus: () => {},
            onStats: () => {},
            onChart: (sweep) => {
                const updatedIdx = sweep.findIndex((s, i) => s !== lastSweep[i]);
                // Capture a snapshot whenever level 30 (index 29) is the just-updated entry,
                // i.e., a full sweep just finished.
                if (updatedIdx === 29) {
                    const snap = sweep.map(s => ({ accuracy: s?.s?.accuracy ?? -1 }));
                    if (coarseSweepSnap === null) {
                        coarseSweepSnap = snap;
                    } else {
                        finalSweepSnap = snap;
                    }
                }
                lastSweep = [...sweep];
            },
        });

        // Fire coarse tier progress → first chart sweep with coarse threshold
        assert.strictEqual(mainQueue.length, 1, 'progressive request should be queued');
        const q4 = mainQueue[0];
        assert.ok(q4 !== undefined);
        q4.onProgress?.({ stats: makeStats(0.1) });
        await flush();

        // Fire standard tier progress → second chart sweep with finer threshold
        const q5 = mainQueue[0];
        assert.ok(q5 !== undefined);
        q5.onProgress?.({ stats: makeStats(0.01) });

        // Wait for both sweeps to complete
        for (let i = 0; i < 8; i++) await flush();

        assert.ok(coarseSweepSnap !== null, 'Should have captured a coarse sweep snapshot');
        assert.ok(finalSweepSnap !== null, 'Should have captured a final sweep snapshot (requires >= 2 sweeps)');

        // At least some levels should show increased accuracy in the final pass
        let improved = false;
        const final = finalSweepSnap as any[];
        const coarse = coarseSweepSnap as any[];
        for (let i = 0; i < 30; i++) {
            if (final[i].accuracy > coarse[i].accuracy + 0.00001) {
                improved = true;
                break;
            }
        }
        const f0 = final[0];
        const c0 = coarse[0];
        assert.ok(f0 !== undefined && c0 !== undefined);
        assert.ok(improved, 
            `Expected the final sweep to increase accuracy for at least one level. ` +
            `Coarse[0]: ${c0.accuracy}, Final[0]: ${f0.accuracy}`
        );

        // Clean up
        const q0 = mainQueue[0];
        assert.ok(q0 !== undefined);
        q0.resolve({ stats: makeStats(0.01) });
        await flush();
    });
});


