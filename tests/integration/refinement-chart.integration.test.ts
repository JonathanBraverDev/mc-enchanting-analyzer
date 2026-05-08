import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { RefinementService } from '#ui/refinement.js';
import { WorkerClient } from '#ui/worker-client.js';
import { TEST_DATA } from '#tests/infra/test-data.js';

/** Flush pending macrotasks (AsyncUtils.yield uses setTimeout 0). */
function flush(): Promise<void> {
    return new Promise(r => setTimeout(r, 20));
}

const BASE_PAYLOAD = TEST_DATA.PAYLOADS.BASE_SWORD;

describe('Integration: Chart sweep with mocked WorkerClient', () => {
    let originalStartTop: typeof WorkerClient.startTopRun;
    let originalStartChart: typeof WorkerClient.startChartRun;

    beforeEach(() => {
        originalStartTop = WorkerClient.startTopRun;
        originalStartChart = WorkerClient.startChartRun;
    });

    afterEach(() => {
        WorkerClient.startTopRun = originalStartTop;
        WorkerClient.startChartRun = originalStartChart;
    });

    it('sequential chart sweep: levels populate 1→30 in order', async () => {
        const service = new RefinementService();
        let lastSweep: (any | null)[] = new Array(30).fill(null);
        const chartPopulatedLog: number[] = [];

        WorkerClient.startTopRun = (_input, _refinement, _onUpdate, onTerminal) => {
            setTimeout(() => onTerminal('done'), 1);
            return 'top-run' as any;
        };

        WorkerClient.startChartRun = (_input, refinement, onUpdate, onTerminal) => {
            // The chart worker processes all levels. For this test, we just stream one pass.
            const level = refinement[0]!;
            for (let i = 1; i <= 30; i++) {
                onUpdate({
                    xpLevel: i,
                    refinementLevel: level,
                    normalization: { domain: 'resolved-mass' },
                    buckets: { anyByEnchantId: {}, rankByIdAndRank: {}, countBySize: {} }
                } as any);
            }
            onTerminal('done');
            return 'chart-run' as any;
        };

        await service.run(BASE_PAYLOAD, { mechanics: { xp_cap: 30 } } as any, {
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

        await flush();

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

    it('accuracy improves between coarse and final passes (streaming checkpoints)', async () => {
        const service = new RefinementService();
        let coarseSweepSnap: any[] | null = null;
        let finalSweepSnap: any[] | null = null;

        WorkerClient.startTopRun = (_input, _refinement, _onUpdate, onTerminal) => {
            setTimeout(() => onTerminal('done'), 1);
            return 'top-run' as any;
        };

        WorkerClient.startChartRun = (_input, refinement, onUpdate, onTerminal) => {
            refinement.forEach((level, levelIdx) => {
                const accuracy = (level === 'coarse') ? 0.9 : 0.999;
                setTimeout(() => {
                    for (let i = 1; i <= 30; i++) {
                        onUpdate({
                            xpLevel: i,
                            refinementLevel: level,
                            normalization: { domain: 'resolved-mass' },
                            accounting: { resolved: accuracy },
                            buckets: { anyByEnchantId: {}, rankByIdAndRank: {}, countBySize: {} }
                        } as any);
                    }
                    if (levelIdx === refinement.length - 1) onTerminal('done');
                }, levelIdx * 5);
            });
            return 'chart-run' as any;
        };

        await service.run(BASE_PAYLOAD, { mechanics: { xp_cap: 30 } } as any, {
            onStatus: () => {},
            onStats: () => {},
            onChart: (sweep: any) => {
                if (!sweep) return;
                const cell = sweep[29];
                if (cell) {
                    const snap = sweep.map((s: any) => ({ accuracy: s?.accounting?.resolved ?? -1 }));
                    const firstAccuracy = snap[0].accuracy;
                    if (firstAccuracy > 0 && firstAccuracy < 0.95 && coarseSweepSnap === null) {
                        coarseSweepSnap = snap;
                    } else if (firstAccuracy > 0.95 && finalSweepSnap === null) {
                        finalSweepSnap = snap;
                    }
                }
            },
        });

        await flush();

        assert.ok(coarseSweepSnap !== null, 'Should have captured a coarse sweep snapshot');
        assert.ok(finalSweepSnap !== null, 'Should have captured a final sweep snapshot');

        let improved = false;
        const final: any = finalSweepSnap;
        const coarse: any = coarseSweepSnap;
        for (let i = 0; i < 30; i++) {
            if (final[i].accuracy > coarse[i].accuracy + 0.00001) {
                improved = true;
                break;
            }
        }
        assert.ok(improved, 'Expected the final sweep to increase accuracy for at least one level.');
    });
});
