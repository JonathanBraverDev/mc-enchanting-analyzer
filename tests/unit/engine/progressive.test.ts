import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory } from '#core/factory.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { EnchantEngine } from '#engine/index.js';
import { EngineFactory } from '#engine/factory.js';
import { TEST_DATA } from '#tests/infra/test-data.js';

describe('EnchantEngine: Sequential Checkpoint Search', () => {

    let cache: CacheManager;
    let engine: EnchantEngine;

    beforeEach(() => {
        EngineFactory.clearCaches();
        cache = new CacheManager({ comboOtherSize: 100, comboBookSize: 100, poolSize: 100 });
        engine = EngineFactory.create(RegistryFactory.build(TEST_DATA.VERSIONS.MODERN), { cache });
    });

    it('should improve accuracy monotonically across checkpoints', async () => {
        const accuracies: number[] = [];
        const checkpoints = [
            { threshold: 0.1,   limit: 100 },
            { threshold: 0.01,  limit: 500 },
            { threshold: 0.001, limit: 1000 }
        ];

        await engine.searchSequentialCheckpoints({
            item: TEST_DATA.ITEMS.SWORD,
            xp: 30,
            material: TEST_DATA.MATERIALS.DIAMOND,
            checkpoints,
            onCheckpointComplete: (result) => {
                accuracies.push(result.snapshot.mass.resolved);
            }
        });

        assert.strictEqual(accuracies.length, 3, 'Should have fired 3 checkpoint callbacks');
        for (let i = 1; i < accuracies.length; i++) {
            assert.ok((accuracies[i] ?? 0) >= (accuracies[i-1] ?? 0), `Accuracy should be monotonic. Checkpoint ${i} (${accuracies[i]}) < checkpoint ${i-1} (${accuracies[i-1]})`);
        }
    });

    it('should respect the uncertainty threshold and stop early if possible', async () => {
        let checkpointCount = 0;
        const checkpoints = [
            { threshold: 1e-10, limit: 5000 }, // Deep first pass
            { threshold: 0.1,   limit: 10 },    // Very shallow second pass
        ];

        const finalResult = await engine.searchSequentialCheckpoints({
            item: TEST_DATA.ITEMS.SWORD,
            xp: 30,
            material: TEST_DATA.MATERIALS.DIAMOND,
            checkpoints,
            onCheckpointComplete: () => {
                checkpointCount++;
            }
        });

        assert.ok(checkpointCount >= 1);
        assert.ok(finalResult.snapshot.mass.resolved > 0.99);
    });

    it('should recover rounding residue between checkpoints (High Precision)', async () => {
        let roundingValues: number[] = [];
        const checkpoints = [
            { threshold: 0.1,   limit: 100 },
            { threshold: 0.01,  limit: 1000 }
        ];

        await engine.searchSequentialCheckpoints({
            item: TEST_DATA.ITEMS.SWORD,
            xp: 30,
            material: TEST_DATA.MATERIALS.DIAMOND,
            checkpoints,
            onCheckpointComplete: (result) => {
                roundingValues.push(result.snapshot.mass.rounding);
            }
        });

        assert.strictEqual(roundingValues.length, 2);
        assert.ok((roundingValues[1] ?? 0) <= (roundingValues[0] ?? 0) + 1e-15, 'Rounding mass should not balloon between checkpoints');
    });
});
