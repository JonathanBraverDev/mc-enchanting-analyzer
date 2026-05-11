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
import { TEST_DATA } from '#tests/infra/test-data.js';

// Matches the tolerance used in engine.test.ts "Frontier Mass Tracking" test.
const TOLERANCE = TEST_DATA.THRESHOLDS.PROB_MIN;

afterEach(() => {
    // No global cache manager
});

/** sum of all mass buckets from the accounting object */
function massTotal(stats: any): number {
    const acc = stats.accounting;
    return acc.resolved + acc.clueIncompatible + acc.pending + acc.sieved + acc.overflow + acc.capped + acc.rounding;
}

describe('Probability Conservation', () => {

    it('pending mass is non-negative for a partially-converged search', async () => {
        const engine = EngineFactory.createForVersion(TEST_DATA.VERSIONS.MODERN);
        const stats  = await engine.getStats({ item: 'chestplate', xp: 15, material: 'iron', threshold: 0.01 });

        assert.ok(
            stats.accounting.pending >= 0,
            `pending mass should be >= 0, got ${stats.accounting.pending}`
        );
    });

    it('sum(buckets) ≈ 1.0 for a partially-converged search', async () => {
        const engine = EngineFactory.createForVersion('1.21');
        const stats  = await engine.getStats({ item: 'chestplate', xp: 15, material: 'iron', threshold: 0.01 });

        const total = massTotal(stats);
        assert.ok(
            Math.abs(total - 1.0) < TOLERANCE,
            `sum(buckets) = ${total}, expected ≈ 1.0. Breakdown: ${JSON.stringify(stats.accounting)}`
        );
    });

    it('sum(buckets) ≈ 1.0 for a fully-converged book search (modern)', async () => {
        const engine = EngineFactory.createForVersion(TEST_DATA.VERSIONS.MODERN);
        const stats  = await engine.getStats({ item: TEST_DATA.ITEMS.BOOK, xp: 30, material: TEST_DATA.MATERIALS.BOOK, threshold: TEST_DATA.THRESHOLDS.PROB_MIN });

        const total = massTotal(stats);
        assert.ok(
            Math.abs(total - 1.0) < TOLERANCE,
            `sum(buckets) = ${total}, expected ≈ 1.0. Breakdown: ${JSON.stringify(stats.accounting)}`
        );
    });

    it('accuracy >= 0 and sum(buckets) ≈ 1.0 across items/versions', async () => {
        const cases: Array<{ version: string; item: string; level: number; material: string }> = [
            { version: TEST_DATA.VERSIONS.CLASSIC, item: TEST_DATA.ITEMS.SWORD, level: 30, material: TEST_DATA.MATERIALS.DIAMOND },
            { version: '1.14.3', item: 'chestplate', level: 30, material: TEST_DATA.MATERIALS.DIAMOND }, // Custom boundary before netherite exists
            { version: TEST_DATA.VERSIONS.MODERN,  item: TEST_DATA.ITEMS.MACE, level: 15, material: TEST_DATA.MATERIALS.MACE },
            { version: TEST_DATA.VERSIONS.BOOK_MULTI_LIMIT, item: TEST_DATA.ITEMS.BOOK, level: 30, material: TEST_DATA.MATERIALS.BOOK },
        ];

        for (const { version, item, level, material } of cases) {
            const engine = EngineFactory.createForVersion(version);
            const stats  = await engine.getStats({ item: item, xp: level, material: material, threshold: 0.001 });
            const label  = `${version} ${item}@${level} ${material}`;

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

    it('guaranteed clue result remains complete for bow (Power IV)', async () => {
        const engine  = EngineFactory.createForVersion(TEST_DATA.VERSIONS.MODERN);
        const stats   = await engine.getStats({
            item: 'bow',
            xp: 30,
            material: 'bow',
            clue: 'Power IV',
            threshold: TEST_DATA.THRESHOLDS.PROB_MIN,
        });

        const total = massTotal(stats);
        assert.ok(
            Math.abs(total - 1.0) < TOLERANCE,
            `sum(buckets) = ${total} ≠ 1.0. Breakdown: ${JSON.stringify(stats.accounting)}`
        );
        assert.ok(stats.accounting.resolved > 0, 'clue-aware search should resolve compatible mass');
        assert.ok(stats.accounting.clueIncompatible > 0, 'clue-aware search should classify incompatible mass');

        const powerId = engine.registry.idMap.get('Power')!;
        assert.ok(
            (stats.any[powerId] ?? 0) > 0.99,
            `Guaranteed enchant anyMass should stay dominant, got ${stats.any[powerId]}`
        );
    });
});
