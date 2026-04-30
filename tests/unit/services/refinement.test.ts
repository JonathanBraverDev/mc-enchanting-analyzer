import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { RefinementService } from '#ui/refinement.js';
import { WorkerClient } from '#ui/worker-client.js';

describe('RefinementService (V5)', () => {
    let service: RefinementService;
    let originalStartTop: typeof WorkerClient.startTopRun;
    let originalStartChart: typeof WorkerClient.startChartRun;

    beforeEach(() => {
        service = new RefinementService();
        originalStartTop = WorkerClient.startTopRun;
        originalStartChart = WorkerClient.startChartRun;
        
        // Mock static-style WorkerClient
        WorkerClient.startTopRun = (_input, refinement, onUpdate) => {
            setTimeout(() => {
                onUpdate({
                    input: _input,
                    refinementLevel: refinement[0]!,
                    clueConditioned: !!_input.clue,
                    normalization: { domain: 'resolved-mass' },
                    accounting: { resolved: 0.9, pending: 0.1, sieved: 0, overflow: 0, capped: 0, rounding: 0 },
                    combos: [],
                    enchants: []
                });
            }, 1);
            return 'test-run-id' as any;
        };

        WorkerClient.startChartRun = (_input, refinement, onUpdate, onTerminal) => {
            setTimeout(() => {
                onUpdate({
                    xpLevel: 30,
                    passId: 'coarse' as any,
                    refinementLevel: refinement[0]!,
                    clueConditioned: !!_input.clue,
                    normalization: { domain: 'resolved-mass' },
                    buckets: { anyByEnchantId: {}, rankByIdAndRank: {}, countBySize: {} }
                } as any);
                onTerminal();
            }, 1);
            return 'test-chart-id' as any;
        };
    });

    afterEach(() => {
        WorkerClient.startTopRun = originalStartTop;
        WorkerClient.startChartRun = originalStartChart;
    });

    it('should complete a full 4-tier refinement', async () => {
        const payload = {
            category: 'sword',
            material: 'diamond',
            clue: null,
            xpLevel: 30,
            version: '1.21'
        };

        const statsCalls: any[] = [];
        await service.run(payload, { mechanics: { xp_cap: 30 } } as any, {
            onStatus: () => {},
            onStats: (view) => {
                statsCalls.push(view);
            },
            onChart: () => {}
        });

        // 4 tiers: coarse, standard, deep, ultra
        assert.strictEqual(statsCalls.length, 4);
        assert.strictEqual(statsCalls[0].refinementLevel, 'coarse');
        assert.strictEqual(statsCalls[3].refinementLevel, 'ultra');
    });

    it('should correctly mark the final tier', async () => {
        const payload = {
            category: 'sword',
            material: 'diamond',
            clue: null,
            xpLevel: 30,
            version: '1.21'
        };

        let lastIsFinal = false;
        await service.run(payload, { mechanics: { xp_cap: 30 } } as any, {
            onStatus: () => {},
            onStats: (_, isFinal) => {
                lastIsFinal = isFinal;
            },
            onChart: () => {}
        });

        assert.strictEqual(lastIsFinal, true);
    });
});
