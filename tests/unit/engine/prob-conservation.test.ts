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
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { TEST_DATA } from '#tests/infra/test-data.js';

// Matches the tolerance used in engine.test.ts "Frontier Mass Tracking" test.
const TOLERANCE = TEST_DATA.THRESHOLDS.PROB_MIN;

afterEach(() => {
    // No global cache manager
});

/** sum of all mass buckets from the accounting object */
function massTotal(stats: any): number {
    const acc = stats.accounting;
    return acc.resolved + acc.pending + acc.sieved + acc.overflow + acc.capped + acc.rounding;
}

describe('Probability Conservation', () => {

    it('pending mass is non-negative for a partially-converged search', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        const stats  = await engine.calculate('chestplate', 15, 'iron', { threshold: 0.01 });

        assert.ok(
            stats.accounting.pending >= 0,
            `pending mass should be >= 0, got ${stats.accounting.pending}`
        );
    });

    it('sum(buckets) ≈ 1.0 for a partially-converged search', async () => {
        const engine = EngineFactory.create(DATA, '1.21');
        const stats  = await engine.calculate('chestplate', 15, 'iron', { threshold: 0.01 });

        const total = massTotal(stats);
        assert.ok(
            Math.abs(total - 1.0) < TOLERANCE,
            `sum(buckets) = ${total}, expected ≈ 1.0. Breakdown: ${JSON.stringify(stats.accounting)}`
        );
    });

    it('sum(buckets) ≈ 1.0 for a fully-converged book search (modern)', async () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        const stats  = await engine.calculate(TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, { threshold: TEST_DATA.THRESHOLDS.PROB_MIN });

        const total = massTotal(stats);
        assert.ok(
            Math.abs(total - 1.0) < TOLERANCE,
            `sum(buckets) = ${total}, expected ≈ 1.0. Breakdown: ${JSON.stringify(stats.accounting)}`
        );
    });

    it('accuracy >= 0 and sum(buckets) ≈ 1.0 across items/versions', async () => {
        const cases: Array<{ version: string; cat: string; level: number; mat: string }> = [
            { version: TEST_DATA.VERSIONS.CLASSIC, cat: TEST_DATA.ITEMS.SWORD, level: 30, mat: TEST_DATA.MATERIALS.DIAMOND },
            { version: '1.14.3', cat: 'chestplate', level: 30, mat: TEST_DATA.MATERIALS.NETHERITE }, // Custom boundary
            { version: TEST_DATA.VERSIONS.MODERN,  cat: TEST_DATA.ITEMS.MACE, level: 15, mat: TEST_DATA.MATERIALS.MACE },
            { version: TEST_DATA.VERSIONS.BOOK_MULTI_LIMIT, cat: TEST_DATA.ITEMS.BOOK, level: 30, mat: TEST_DATA.MATERIALS.BOOK },
        ];

        for (const { version, cat, level, mat } of cases) {
            const engine = EngineFactory.create(DATA, version);
            const stats  = await engine.calculate(cat, level, mat, { threshold: 0.001 });
            const label  = `${version} ${cat}@${level} ${mat}`;

            assert.ok(
                stats.accuracy >= 0,
                `accuracy < 0 for ${label}: got ${stats.accuracy}`
            );

            const total = massTotal(stats);
            assert.ok(
                Math.abs(total - 1.0) < TOLERANCE,
                `sum(buckets) = ${total} ≠ 1.0 for ${label}. Breakdown: ${JSON.stringify(stats.accounting)}`
            );
        }
    });

    it('guaranteed enchant accuracy is 1.0 for bow (Power IV)', async () => {
        const engine  = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        const stats   = await engine.calculate('bow', 30, 'bow', {
            clue: 'Power IV',
            threshold: TEST_DATA.THRESHOLDS.PROB_MIN,
        });

        assert.ok(
            stats.accuracy >= 1.0 - TOLERANCE,
            `Guaranteed enchant accuracy should be ≈ 1.0, got ${stats.accuracy}. Breakdown: ${JSON.stringify(stats.accounting)}`
        );

        const powerId = engine.registry.idMap.get('Power')!;
        assert.strictEqual(
            stats.any[powerId],
            1.0,
            `Guaranteed enchant anyMass should be exactly 1.0, got ${stats.any[powerId]}`
        );
    });
});
