/**
 * Probability conservation tests.
 *
 * Verified invariants for any completed or partially-converged search result:
 *   1. uncertainty >= 0
 *   2. sum(count probs) + uncertainty ≈ 1.0  (within TOLERANCE due to BigInt→float rounding)
 *
 * Note: stats.combos may be truncated by summaryLimit, so these tests use
 * stats.count which is always complete.
 *
 * Coverage not duplicated from engine.test.ts:
 *  - Explicit uncertainty >= 0 assertion (engine tests check the combined total but never
 *    assert the sign directly for non-guaranteed cases)
 *  - Multiple items/materials/versions in a single loop
 *  - Guaranteed enchant anyMass=1.0 for bow (engine tests cover sword/book)
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from '../engine/index.js';
import { DATA } from '../data/index.js';

// Matches the tolerance used in engine.test.ts "Frontier Mass Tracking" test.
const TOLERANCE = 1e-4;

afterEach(() => {
    EnchantEngine.clearAllEngines();
});

/** sum of per-count probabilities (not truncated, unlike stats.combos) */
function countSum(stats: any): number {
    return Object.values(stats.count as Record<string, number>).reduce((a, b) => a + b, 0);
}

describe('Probability Conservation', () => {

    it('uncertainty is non-negative for a partially-converged search', async () => {
        const engine = new EnchantEngine(DATA, '1.21');
        const stats  = await engine.getFullStats('chestplate', 15, 'iron', { threshold: 0.01, useBestCache: false });

        assert.ok(
            stats.uncertainty >= 0,
            `uncertainty should be >= 0, got ${stats.uncertainty}`
        );
    });

    it('sum(count) + uncertainty ≈ 1.0 for a partially-converged search', async () => {
        const engine = new EnchantEngine(DATA, '1.21');
        // threshold=0.01 → meaningful uncertainty left in the frontier
        const stats  = await engine.getFullStats('chestplate', 15, 'iron', { threshold: 0.01, useBestCache: false });

        const total = countSum(stats) + stats.uncertainty;
        assert.ok(
            Math.abs(total - 1.0) < TOLERANCE,
            `sum(count) + uncertainty = ${total}, expected ≈ 1.0`
        );
    });

    it('sum(count) + uncertainty ≈ 1.0 for a fully-converged book search (1.20)', async () => {
        const engine = new EnchantEngine(DATA, '1.20');
        const stats  = await engine.getFullStats('book', 30, 'book', { threshold: 0.0001, useBestCache: false });

        const total = countSum(stats) + stats.uncertainty;
        assert.ok(
            Math.abs(total - 1.0) < TOLERANCE,
            `sum(count) + uncertainty = ${total}, expected ≈ 1.0`
        );
    });

    it('uncertainty >= 0 and sum(count) + uncertainty ≈ 1.0 across items/versions', async () => {
        const cases: Array<{ version: string; cat: string; level: number; mat: string }> = [
            { version: '1.8',    cat: 'sword',      level: 30, mat: 'diamond'   },
            { version: '1.14.3', cat: 'chestplate', level: 30, mat: 'netherite' },
            { version: '1.21',   cat: 'mace',       level: 15, mat: 'mace'      },
            { version: '1.7.2',  cat: 'book',       level: 30, mat: 'book'      },
        ];

        for (const { version, cat, level, mat } of cases) {
            const engine = new EnchantEngine(DATA, version);
            const stats  = await engine.getFullStats(cat, level, mat, { threshold: 0.001, useBestCache: false });
            const label  = `${version} ${cat}@${level} ${mat}`;

            assert.ok(
                stats.uncertainty >= 0,
                `uncertainty < 0 for ${label}: got ${stats.uncertainty}`
            );

            const total = countSum(stats) + stats.uncertainty;
            assert.ok(
                Math.abs(total - 1.0) < TOLERANCE,
                `sum(count)+uncertainty = ${total} ≠ 1.0 for ${label}`
            );
        }
    });

    it('guaranteed enchant anyMass = 1.0 for bow (Power IV)', async () => {
        const engine  = new EnchantEngine(DATA, '1.21');
        const stats   = await engine.getFullStats('bow', 30, 'bow', {
            guaranteedFirst: 'Power IV',
            threshold: 0.0001,
            useBestCache: false,
        });
        const powerId = engine.registry.idMap.get('Power')!;

        assert.strictEqual(
            stats.any[powerId],
            1.0,
            `Guaranteed enchant anyMass should be exactly 1.0, got ${stats.any[powerId]}`
        );
    });
});
