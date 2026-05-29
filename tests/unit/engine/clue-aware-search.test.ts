import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { ClueValidator } from '#core/clue.js';
import { TEST_DATA } from '#tests/infra/test-data.js';
import { summarizeCheckpoint } from '#tests/infra/clue-test-utils.js';
import type { EnchantStats } from '#types/index.js';

describe('Clue-aware search optimization', () => {
    const assertClueConditionedStats = async (item: string, material: string, clue: string, threshold = 0.005) => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();
        const targetClueId = ClueValidator.validate(engine.registry, item, clue);
        const stats = await engine.getStats({
            item,
            xp: 30,
            material,
            clue,
            threshold,
            useCache: false,
            summaryLimit: 1000
        });

        assert.strictEqual(stats.clue?.idAndRank, targetClueId);
        assert.strictEqual(stats.shownClueDistribution, undefined);
        assert.ok((stats.clue?.knownSpace ?? 0) > 0, `${clue} should expose clue known space`);
        assert.ok(stats.accounting.clueIncompatible > 0, `${clue} should account clue-incompatible mass`);
        assert.ok(stats.accuracy >= 0 && stats.accuracy <= 1);
    };

    it('conditions wrong-rank and conflicting sword branches through the clue path', async () => {
        await assertClueConditionedStats(TEST_DATA.ITEMS.SWORD, TEST_DATA.MATERIALS.DIAMOND, 'Sharpness IV');
    });

    it('conditions common and rare modern book clue inputs through the clue path', async () => {
        await assertClueConditionedStats(TEST_DATA.ITEMS.BOOK, TEST_DATA.MATERIALS.BOOK, 'Protection III', 0.01);
        await assertClueConditionedStats(TEST_DATA.ITEMS.BOOK, TEST_DATA.MATERIALS.BOOK, 'Projectile Protection IV', 0.01);
    });

    it('searchToCheckpoint forwards clue pruning through the public checkpoint API', async () => {
        const item = TEST_DATA.ITEMS.SWORD;
        const material = TEST_DATA.MATERIALS.DIAMOND;
        const clue = 'Sharpness IV';
        const threshold = 0.005;
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();
        const targetClueId = ClueValidator.validate(engine.registry, item, clue);

        const result = await engine.searchToCheckpoint({
            item,
            xp: 30,
            material,
            clue,
            threshold,
            useCache: false
        });
        const stats = summarizeCheckpoint(engine, result, item, clue);

        assert.strictEqual(stats.clue?.idAndRank, targetClueId);
        assert.strictEqual(stats.shownClueDistribution, undefined);
        assert.ok((stats.clue?.knownSpace ?? 0) > 0);
        assert.ok(result.snapshot.mass.clueIncompatible > 0);
    });

    it('searchSequentialCheckpoints forwards clue pruning for every streamed checkpoint', async () => {
        const item = TEST_DATA.ITEMS.BOOK;
        const material = TEST_DATA.MATERIALS.BOOK;
        const clue = 'Protection III';
        const checkpoints = [
            { threshold: 0.05, limit: 15_000 },
            { threshold: 0.01, limit: 40_000 }
        ];
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();
        const targetClueId = ClueValidator.validate(engine.registry, item, clue);
        const streamed: EnchantStats[] = [];
        const clueIncompatibleMass: number[] = [];

        await engine.searchSequentialCheckpoints({
            item,
            xp: 30,
            material,
            clue,
            checkpoints,
            useCache: false,
            onCheckpointComplete: (result) => {
                streamed.push(summarizeCheckpoint(engine, result, item, clue));
                clueIncompatibleMass.push(result.snapshot.mass.clueIncompatible);
            }
        });

        assert.strictEqual(streamed.length, checkpoints.length);
        for (let i = 0; i < checkpoints.length; i++) {
            const stats = streamed[i]!;
            assert.strictEqual(stats.clue?.idAndRank, targetClueId);
            assert.strictEqual(stats.shownClueDistribution, undefined);
            assert.ok((stats.clue?.knownSpace ?? 0) > 0);
            assert.ok(clueIncompatibleMass[i]! > 0);
        }
    });
});
