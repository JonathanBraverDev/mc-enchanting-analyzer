import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { RefinementService, RefinementPayload } from '#ui/refinement.js';
import { RegistryFactory } from '#core/factory.js';
import { WorkerClient } from '#ui/worker-client.js';

const EMPTY_BUCKETS = { anyByEnchantId: {}, rankByIdAndRank: {}, countBySize: {} };
const RESOLVED_NORMALIZATION = { domain: 'resolved-mass' as const };

/** Flush pending macrotasks (AsyncUtils.yield uses setTimeout 0). */
function flush(): Promise<void> {
    return new Promise(r => setTimeout(r, 20));
}

describe('XP Cap Sweep Integration', () => {
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

    it('should sweep up to 30 for modern version (1.21)', async () => {
        const registry = RegistryFactory.build('1.21');
        const service = new RefinementService();

        let lastSweepLength = 0;

        WorkerClient.startTopRun = (_input, _refinement, _onUpdate, onTerminal) => {
            setTimeout(() => onTerminal('done'), 1);
            return 'top-run' as any;
        };

        WorkerClient.startChartRun = (_input, _refinement, onUpdate, onTerminal) => {
            const xpCap = registry.mechanics.xp_cap || 30;
            for (let i = 1; i <= xpCap; i++) {
                onUpdate({
                    xpLevel: i,
                    refinementLevel: 'ultra',
                    clueConditioned: false,
                    normalization: RESOLVED_NORMALIZATION,
                    buckets: EMPTY_BUCKETS
                });
            }
            onTerminal('done');
            return 'chart-run' as any;
        };

        const payload: RefinementPayload = {
            item: 'sword',
            material: 'diamond',
            clue: null,
            xpLevel: 30,
            version: '1.21'
        };

        await service.run(payload, registry, {
            onStatus: () => {},
            onStats: () => {},
            onChart: (sweep) => {
                lastSweepLength = sweep.length;
            }
        });

        await flush();
        assert.strictEqual(lastSweepLength, 30, 'Modern sweep should be 30 levels');
    });

    it('should sweep up to 50 for legacy version (1.1)', async () => {
        const registry = RegistryFactory.build('1.1');
        const service = new RefinementService();

        let lastSweepLength = 0;

        WorkerClient.startTopRun = (_input, _refinement, _onUpdate, onTerminal) => {
            setTimeout(() => onTerminal('done'), 1);
            return 'top-run' as any;
        };

        WorkerClient.startChartRun = (_input, _refinement, onUpdate, onTerminal) => {
            const xpCap = registry.mechanics.xp_cap || 50;
            for (let i = 1; i <= xpCap; i++) {
                onUpdate({
                    xpLevel: i,
                    refinementLevel: 'ultra',
                    clueConditioned: false,
                    normalization: RESOLVED_NORMALIZATION,
                    buckets: EMPTY_BUCKETS
                });
            }
            onTerminal('done');
            return 'chart-run' as any;
        };

        const payload: RefinementPayload = {
            item: 'sword',
            material: 'diamond',
            clue: null,
            xpLevel: 50,
            version: '1.1'
        };

        await service.run(payload, registry, {
            onStatus: () => {},
            onStats: () => {},
            onChart: (sweep) => {
                lastSweepLength = sweep.length;
            }
        });

        await flush();
        assert.strictEqual(lastSweepLength, 50, 'Legacy sweep should be 50 levels');
    });
});
