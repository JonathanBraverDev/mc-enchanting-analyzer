import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { RefinementService } from '#ui/refinement.js';
import { WorkerClient } from '#ui/worker-client.js';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { TEST_DATA } from '#tests/infra/test-data.js';
import { SnapshotService } from '#services/SnapshotService.js';
import { SummaryService } from '#services/SummaryService.js';

const BASE_PAYLOAD = TEST_DATA.PAYLOADS.BASE_SWORD;

describe('Integration: RefinementService V5 Contract', () => {
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

    it('Correction 1: should stream all 4 checkpoints in a single run', async () => {
        let callCount = 0;
        WorkerClient.startTopRun = (_input, _refinement, _onUpdate, onTerminal) => {
            callCount++;
            const refinement = ['coarse', 'standard', 'deep', 'ultra'];
            refinement.forEach((level, i) => {
                setTimeout(() => {
                    _onUpdate({
                        input: _input,
                        refinementLevel: level,
                        clueConditioned: false,
                        normalization: { domain: 'resolved-mass' },
                        accounting: { resolved: 0.9, pending: 0.1, sieved: 0, overflow: 0, capped: 0, rounding: 0 },
                        combos: [],
                        enchants: []
                    } as any);
                    if (i === refinement.length - 1) onTerminal('done');
                }, 10);
            });
            return 'run-id' as any;
        };

        WorkerClient.startChartRun = (_input, _refinement, _onUpdate, onTerminal) => {
            setTimeout(() => onTerminal('done'), 50);
            return 'chart-id' as any;
        };

        const service = new RefinementService();
        const results: string[] = [];

        await service.run(BASE_PAYLOAD, { mechanics: { xp_cap: 30 } } as any, {
            onStatus: () => {},
            onStats: (view) => { results.push(view.refinementLevel); },
            onChart: () => {},
        });

        assert.strictEqual(callCount, 1, 'startTopRun should be called exactly once');
        assert.strictEqual(results.length, 4, 'Should receive 4 refinement levels');
        assert.deepStrictEqual(results, ['coarse', 'standard', 'deep', 'ultra']);
    });
});

describe('Integration: Snapshot Integrity (Correction 4)', () => {
    it('unconditioned snapshot masses should match engine summary exactly', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        const res = await engine.searchToCheckpoint({
            cat: TEST_DATA.ITEMS.BOOK,
            xp: 30,
            mat: TEST_DATA.MATERIALS.DIAMOND,
            threshold: 1n // Very low threshold to ensure many combinations
        });

        const summary = SummaryService.summarize(
            res.combos,
            res.tracker,
            engine.registry.indexToEnchant,
            30 // comboLimit
        );

        const snapshot = SnapshotService.create(
            engine.registry,
            res.tracker,
            res.combos,
            {
                snapshotType: 'top',
                input: {
                    category: TEST_DATA.ITEMS.BOOK,
                    xpLevel: 30,
                    material: TEST_DATA.MATERIALS.DIAMOND,
                    clue: null,
                    version: TEST_DATA.VERSIONS.MODERN
                },
                refinementLevel: 'ultra',
                clue: null
            }
        ) as any;

        // Compare "Any" probabilities
        for (const [idStr, share] of Object.entries(summary.any) as [string, number][]) {
            const id = parseInt(idStr);
            const snapEnchant = snapshot.enchants.find((e: any) => e.enchantId === id);
            assert.ok(snapEnchant, `Enchant ID ${id} missing from snapshot`);
            assert.ok(Math.abs(snapEnchant.share - (share as number)) < 1e-10, `Share mismatch for ID ${id}: expected ${share}, got ${snapEnchant.share}`);
        }
    });
});

describe('Integration: Clue Validation (Correction 5)', () => {
    it('should reject invalid clues consistently', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);

        // Unknown enchantment
        await assert.rejects(async () => {
            await engine.calculate({ cat: TEST_DATA.ITEMS.SWORD, xp: 30, mat: TEST_DATA.MATERIALS.DIAMOND, clue: 'FakeEnchant X' });
        }, /Unknown enchantment/);

        // Inapplicable category
        await assert.rejects(async () => {
            await engine.calculate({ cat: TEST_DATA.ITEMS.SWORD, xp: 30, mat: TEST_DATA.MATERIALS.DIAMOND, clue: 'Aqua Affinity I' });
        }, /not applicable to category/);

        // Rank above max
        await assert.rejects(async () => {
            await engine.calculate({ cat: TEST_DATA.ITEMS.SWORD, xp: 30, mat: TEST_DATA.MATERIALS.DIAMOND, clue: 'Sharpness VI' });
        }, /exceeds max/);
    });
});
