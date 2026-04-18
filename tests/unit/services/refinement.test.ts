import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { RefinementService, RefinementPayload } from '#ui/refinement.js';
import { WorkerClient } from '#worker/client.js';
import { TEST_DATA } from '#tests/infra/test-data.js';
import { CalculationStats } from '#types/index.js';

describe('RefinementService', () => {
    let service: RefinementService;

    beforeEach(() => {
        service = new RefinementService();
        
        // Mock static-style WorkerClient
        WorkerClient.request = async (type, payload, onProgress) => {
            if (type === 'calculateProgressive') {
                const tiers = (payload as any).tiers;
                for (let i = 0; i < tiers.length; i++) {
                    // Small delay to ensure it's truly async
                    await new Promise(r => setTimeout(r, 10));
                    onProgress?.({
                        stats: {
                            accuracy: 1.0 - tiers[i].threshold,
                            accounting: { pending: tiers[i].threshold }
                        } as any
                    });
                }
            }
            return { stats: {} as any };
        };

        WorkerClient.resetWorker = async () => {
            await new Promise(r => setTimeout(r, 1));
        };
        
        // Prevent background chart sweeps from interfering with basic state tests
        (service as any).refreshChart = async () => {};
    });

    it('should fire onStats for each pass in sequence', async () => {
        const accuracyValues: number[] = [];
        
        const payload: RefinementPayload = {
            category: TEST_DATA.ITEMS.SWORD,
            material: TEST_DATA.MATERIALS.DIAMOND,
            xpLevel: 30,
            clue: null,
            version: TEST_DATA.VERSIONS.MODERN
        };

        await service.run(payload, {} as any, {
            onStatus: () => {},
            onStats: (stats: CalculationStats) => {
                accuracyValues.push(stats.accuracy);
            },
            onChart: () => {}
        });

        assert.ok(accuracyValues.length >= 2, `Should have fired at least 2 callbacks, got ${accuracyValues.length}`);
    });

    it('should cancel previous runs when run() is called again', async () => {
        let run1Count = 0;
        let run2Count = 0;

        const payload1: RefinementPayload = {
            category: TEST_DATA.ITEMS.SWORD,
            material: TEST_DATA.MATERIALS.DIAMOND,
            xpLevel: 30,
            clue: null,
            version: TEST_DATA.VERSIONS.MODERN
        };

        const payload2 = {
            category: TEST_DATA.ITEMS.BOW,
            material: TEST_DATA.MATERIALS.DIAMOND,
            xpLevel: 30,
            clue: null,
            version: TEST_DATA.VERSIONS.MODERN
        };

        // Start run 1 (don't await yet)
        const p1 = service.run(payload1, {} as any, {
            onStatus: () => {},
            onStats: () => { run1Count++; },
            onChart: () => {}
        });

        // Allow it to start
        await new Promise(r => setTimeout(r, 5));

        // Immediately start run 2
        const p2 = service.run(payload2, {} as any, {
            onStatus: () => {},
            onStats: () => { run2Count++; },
            onChart: () => {}
        });

        await Promise.all([p1, p2]);

        assert.ok(run2Count >= 2, 'Run 2 should have completed its passes');
        assert.ok(run1Count < run2Count, `Run 1 (${run1Count}) should have been truncated by cancellation (Run 2: ${run2Count})`);
    });

    it('should be in "calculating" state during run', async () => {
        assert.strictEqual(service.isCalculating(), false);
        
        const payload: RefinementPayload = {
            category: TEST_DATA.ITEMS.SWORD,
            material: TEST_DATA.MATERIALS.DIAMOND,
            xpLevel: 30,
            clue: null,
            version: TEST_DATA.VERSIONS.MODERN
        };

        const promise = service.run(payload, {} as any, {
            onStatus: () => {},
            onStats: () => {},
            onChart: () => {}
        });
        
        await new Promise(r => setTimeout(r, 5));
        assert.strictEqual(service.isCalculating(), true);
        
        await promise;
        assert.strictEqual(service.isCalculating(), false);
    });
});
