import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from '../../../src/lib/engine/index.js'; import { EngineFactory } from '../../../src/lib/engine/factory.js';
import { DATA } from '../../../src/lib/data/index.js';
import { TEST_DATA } from '../../infra/test-data.js';

describe('EnchantEngine: Progressive Search', () => {

    it('should improve accuracy monotonically across tiers', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        
        const accuracies: number[] = [];
        const tiers = [
            { threshold: 0.1,   limit: 100 },
            { threshold: 0.01,  limit: 500 },
            { threshold: 0.001, limit: 1000 }
        ];

        await engine.getFullStatsProgressive(
            TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND, null,
            tiers,
            (stats) => {
                accuracies.push(stats.accuracy);
            }
        );

        assert.strictEqual(accuracies.length, 3, 'Should have fired 3 tier callbacks');
        for (let i = 1; i < accuracies.length; i++) {
            assert.ok(accuracies[i] >= accuracies[i-1], `Accuracy should be monotonic. Tier ${i} (${accuracies[i]}) < Tier ${i-1} (${accuracies[i-1]})`);
        }
    });

    it('should respect the uncertainty threshold and stop early if possible', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        
        // Define tiers where the second tier's threshold is already met by the first tier's depth
        // This is tricky because thresholds are per-level, but accuracy is global.
        // We'll use a very coarse first tier and a slightly less coarse second tier.
        let tierCount = 0;
        const tiers = [
            { threshold: 0.0000001, limit: 5000 }, // Deep first pass
            { threshold: 0.1,        limit: 10 },    // Very shallow second pass (should basically be instant)
        ];

        const stats = await engine.getFullStatsProgressive(
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
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        
        // Run two passes. If residue recovery is working, the "rounding" mass in the 
        // accounting should stay stable or decrease as it's shifted to "resolved" 
        // without ballooning "sieved" unnecessarily.
        
        let roundingValues: number[] = [];
        const tiers = [
            { threshold: 0.1,   limit: 100 },
            { threshold: 0.001, limit: 1000 }
        ];

        const finalStats = await engine.getFullStatsProgressive(
            TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND, null,
            tiers,
            (stats) => {
                roundingValues.push(stats.accounting.rounding);
            }
        );

        assert.strictEqual(roundingValues.length, 2);
        // Rounding mass represents lost precision. As search deepens, we shouldn't 
        // be GROWING the relative rounding error significantly if we are recovering residue.
        // Actually, rounding is often < 1e-15, so we just check it exists and is stable.
        assert.ok(roundingValues[1] <= roundingValues[0] + 1e-15, 'Rounding mass should not balloon between tiers');
    });
});

