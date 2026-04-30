import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { RefinementService } from '#ui/refinement.js';
import { WorkerClient } from '#ui/worker-client.js';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { TEST_DATA } from '#tests/infra/test-data.js';

/** Flush microtasks and pending timers (AsyncUtils.yield uses setTimeout). */
function flush(): Promise<void> {
    return new Promise(r => setTimeout(r, 20));
}

const BASE_PAYLOAD = TEST_DATA.PAYLOADS.BASE_SWORD;

describe('Integration: RefinementService with mocked WorkerClient', () => {
    let originalStartTop: typeof WorkerClient.startTopRun;
    let originalStartChart: typeof WorkerClient.startChartRun;
    let originalReset: typeof WorkerClient.resetWorker;

    beforeEach(() => {
        originalStartTop = WorkerClient.startTopRun;
        originalStartChart = WorkerClient.startChartRun;
        originalReset = WorkerClient.resetWorker;
        WorkerClient.resetWorker = async () => {};
    });

    afterEach(() => {
        WorkerClient.startTopRun = originalStartTop;
        WorkerClient.startChartRun = originalStartChart;
        WorkerClient.resetWorker = originalReset;
    });

    it('progressive refinement: onStats fires after EACH tier', async () => {
        WorkerClient.startTopRun = (_input, refinement, onUpdate) => {
            setTimeout(() => {
                onUpdate({
                    input: _input,
                    refinementLevel: refinement[0]!,
                    clueConditioned: false,
                    normalization: { domain: 'resolved-mass' },
                    accounting: { resolved: 0.9, pending: 0.1, sieved: 0, overflow: 0, capped: 0, rounding: 0 },
                    combos: [],
                    enchants: []
                });
            }, 10);
            return 'run-id' as any;
        };

        WorkerClient.startChartRun = () => 'chart-id' as any;

        const service = new RefinementService();
        const results: string[] = [];

        await service.run(BASE_PAYLOAD, {} as any, {
            onStatus: () => {},
            onStats: (view) => { results.push(view.refinementLevel); },
            onChart: () => {},
        });

        await flush();
        assert.ok(results.includes('coarse'));
        assert.ok(results.includes('ultra'));
    });
});

describe('Integration: Clue-conditioned certainty checks (engine direct)', () => {
    it('clue conditioning (Sword): Sharpness probability >= 99.99% at level 30', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        const stats = await engine.calculate(TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND, {
            clue: 'Sharpness IV',
            threshold: TEST_DATA.THRESHOLDS.PROB_MIN,
        });
        const sharpnessId = engine.registry.idMap.get('Sharpness')!;
        assert.ok(
            (stats.any[sharpnessId] ?? 0) >= 0.9999,
            `Expected Sharpness prob >= 0.9999, got ${stats.any[sharpnessId]}`
        );
    });
});


