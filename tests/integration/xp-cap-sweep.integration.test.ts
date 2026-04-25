import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { RefinementService, RefinementPayload } from '#ui/refinement.js';
import { RegistryFactory } from '#core/factory.js';
import { WorkerClient } from '#worker/client.js';
import { DATA } from '#data/index.js';

/** Flush pending macrotasks (AsyncUtils.yield uses setTimeout 0). */
function flush(): Promise<void> {
    return new Promise(r => setTimeout(r, 20));
}

function makeStats(accuracy: number): any {
    return { accuracy, accounting: { resolved: accuracy, pending: 1 - accuracy }, ranks: {}, any: {}, count: {}, combos: {} };
}

describe('XP Cap Sweep Integration', () => {
    let originalRequest: typeof WorkerClient.request;
    let originalReset: typeof WorkerClient.resetWorker;

    beforeEach(() => {
        originalRequest = WorkerClient.request;
        originalReset = WorkerClient.resetWorker;
        WorkerClient.resetWorker = async () => {};
    });

    afterEach(() => {
        WorkerClient.request = originalRequest;
        WorkerClient.resetWorker = originalReset;
    });

    it('should sweep up to 30 for modern version (1.21)', async () => {
        const registry = RegistryFactory.build(DATA, '1.21');
        
        type QueueEntry = { onProgress?: (v: any) => void; resolve: (v: any) => void };
        const mainQueue: QueueEntry[] = [];

        WorkerClient.request = (_type: string, payload: any, onProgress?: any): Promise<any> => {
            if (payload.source === 'chart') {
                return Promise.resolve({ stats: makeStats(0.01) });
            }
            return new Promise(resolve => mainQueue.push({ onProgress, resolve }));
        };
        const service = new RefinementService();
        
        const payload: RefinementPayload = {
            category: 'sword',
            material: 'diamond',
            clue: null,
            xpLevel: 30,
            version: '1.21'
        };

        let lastSweepLength = 0;
        await service.run(payload, registry, {
            onStatus: () => {},
            onStats: () => {},
            onChart: (sweep) => {
                lastSweepLength = sweep.length;
            }
        });

        // Trigger first chart sweep
        const q0 = mainQueue[0];
        assert.ok(q0 !== undefined);
        q0.onProgress?.({ stats: makeStats(0.1) });

        // Wait for chart sweep to complete
        for (let i = 0; i < 5; i++) await flush();

        assert.strictEqual(lastSweepLength, 30, 'Modern sweep should be 30 levels');
        
        // Clean up
        q0.resolve({ stats: makeStats(0.1) });
        await flush();
    });

    it('should sweep up to 50 for legacy version (1.1)', async () => {
        const registry = RegistryFactory.build(DATA, '1.1');
        
        type QueueEntry = { onProgress?: (v: any) => void; resolve: (v: any) => void };
        const mainQueue: QueueEntry[] = [];

        WorkerClient.request = (_type: string, payload: any, onProgress?: any): Promise<any> => {
            if (payload.source === 'chart') {
                return Promise.resolve({ stats: makeStats(0.01) });
            }
            return new Promise(resolve => mainQueue.push({ onProgress, resolve }));
        };
        const service = new RefinementService();
        
        const payload: RefinementPayload = {
            category: 'sword',
            material: 'diamond',
            clue: null,
            xpLevel: 50,
            version: '1.1'
        };

        let lastSweepLength = 0;
        await service.run(payload, registry, {
            onStatus: () => {},
            onStats: () => {},
            onChart: (sweep) => {
                lastSweepLength = sweep.length;
            }
        });

        // Trigger first chart sweep
        const q1 = mainQueue[0];
        assert.ok(q1 !== undefined);
        q1.onProgress?.({ stats: makeStats(0.1) });

        // Wait for chart sweep to complete
        for (let i = 0; i < 8; i++) await flush();

        assert.strictEqual(lastSweepLength, 50, 'Legacy sweep should be 50 levels');

        // Clean up
        q1.resolve({ stats: makeStats(0.1) });
        await flush();
    });
});
