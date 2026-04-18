import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { EnchantEngine } from '#engine/index.js';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { TEST_DATA } from '#tests/infra/test-data.js';

describe('EnchantEngine: Progressive Search', () => {

    let cache: CacheManager;
    let engine: EnchantEngine;

    beforeEach(() => {
        EngineFactory.clearCaches();
        cache = new CacheManager({ statsSize: 100, comboOtherSize: 100, comboBookSize: 100, poolSize: 100 });
        engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN, { cache });
    });

    it('should improve accuracy monotonically across tiers', async () => {
        const accuracies: number[] = [];
        const tiers = [
            { threshold: 0.1,   limit: 100 },
            { threshold: 0.01,  limit: 500 },
            { threshold: 0.001, limit: 1000 }
        ];

        await engine.calculateProgressive(
            TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND, null,
            tiers,
            (stats) => {
                accuracies.push(stats.accuracy);
            }
        );

        assert.strictEqual(accuracies.length, 3, 'Should have fired 3 tier callbacks');
        for (let i = 1; i < accuracies.length; i++) {
            assert.ok((accuracies[i] ?? 0) >= (accuracies[i-1] ?? 0), `Accuracy should be monotonic. Tier ${i} (${accuracies[i]}) < Tier ${i-1} (${accuracies[i-1]})`);
        }
    });

    it('should respect the uncertainty threshold and stop early if possible', async () => {
        let tierCount = 0;
        const tiers = [
            { threshold: 1e-10, limit: 5000 }, // Deep first pass
            { threshold: 0.1,   limit: 10 },    // Very shallow second pass
        ];

        const stats = await engine.calculateProgressive(
            TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND, null,
            tiers,
            () => {
                tierCount++;
            }
        );

        assert.ok(tierCount >= 1);
        assert.ok(stats.accuracy > 0.99);
    });

    it('should recover rounding residue between tiers (High Precision)', async () => {
        let roundingValues: number[] = [];
        const tiers = [
            { threshold: 0.1,   limit: 100 },
            { threshold: 0.01,  limit: 1000 }
        ];

        await engine.calculateProgressive(
            TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND, null,
            tiers,
            (stats) => {
                roundingValues.push(stats.accounting.rounding);
            }
        );

        assert.strictEqual(roundingValues.length, 2);
        assert.ok((roundingValues[1] ?? 0) <= (roundingValues[0] ?? 0) + 1e-15, 'Rounding mass should not balloon between tiers');
    });
});
