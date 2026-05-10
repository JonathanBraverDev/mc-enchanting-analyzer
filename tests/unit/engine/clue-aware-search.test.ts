import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { ClueValidator } from '#core/clue.js';
import { TEST_DATA } from '#tests/infra/test-data.js';
import {
    calculateByFullSearchThenCondition,
    calculateWithPruning,
    compareConditionedMaps,
    summarizeCheckpoint
} from '#tests/infra/clue-test-utils.js';
import type { CalculationStats } from '#types/index.js';

describe('Clue-aware search optimization', () => {
    const assertMatchesFullSearchConditioning = async (item: string, material: string, clue: string, threshold = 0.005) => {
        const baseline = await calculateByFullSearchThenCondition(item, material, clue, threshold);
        const optimized = await calculateWithPruning(item, material, clue, threshold);
        const targetClueId = ClueValidator.validate(EngineFactory.createForVersion('1.21.11').registry, item, clue);

        assert.strictEqual(optimized.clue?.knownSpace, baseline.clue?.knownSpace);
        compareConditionedMaps(optimized.any, baseline.any, `${clue} any`);
        compareConditionedMaps(optimized.ranks, baseline.ranks, `${clue} ranks`);
        compareConditionedMaps(optimized.count, baseline.count, `${clue} count`);
        compareConditionedMaps(optimized.combos, baseline.combos, `${clue} combos`);
        assert.strictEqual(optimized.clue?.idAndRank, targetClueId);
        assert.strictEqual(optimized.shownClueDistribution, undefined);
        assert.ok(
            optimized.accounting.clueIncompatible > (baseline.accounting.clueIncompatible ?? 0),
            'optimized clue search should account incompatible branches as clue-incompatible mass'
        );
    };

    it('matches full-search conditioning for wrong-rank and conflicting sword branches', async () => {
        await assertMatchesFullSearchConditioning(TEST_DATA.ITEMS.SWORD, TEST_DATA.MATERIALS.DIAMOND, 'Sharpness IV');
    });

    it('matches full-search conditioning for common and rare modern book clue inputs', async () => {
        await assertMatchesFullSearchConditioning(TEST_DATA.ITEMS.BOOK, TEST_DATA.MATERIALS.BOOK, 'Protection III', 0.01);
        await assertMatchesFullSearchConditioning(TEST_DATA.ITEMS.BOOK, TEST_DATA.MATERIALS.BOOK, 'Projectile Protection IV', 0.01);
    });

    it('searchToCheckpoint forwards clue pruning through the public checkpoint API', async () => {
        const item = TEST_DATA.ITEMS.SWORD;
        const material = TEST_DATA.MATERIALS.DIAMOND;
        const clue = 'Sharpness IV';
        const threshold = 0.005;
        const baseline = await calculateByFullSearchThenCondition(item, material, clue, threshold);
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
        const optimized = summarizeCheckpoint(engine, result, item, clue);

        assert.strictEqual(optimized.clue?.knownSpace, baseline.clue?.knownSpace);
        compareConditionedMaps(optimized.any, baseline.any, `${clue} checkpoint any`);
        compareConditionedMaps(optimized.ranks, baseline.ranks, `${clue} checkpoint ranks`);
        compareConditionedMaps(optimized.count, baseline.count, `${clue} checkpoint count`);
        compareConditionedMaps(optimized.combos, baseline.combos, `${clue} checkpoint combos`);
        assert.strictEqual(optimized.clue?.idAndRank, targetClueId);
        assert.strictEqual(optimized.shownClueDistribution, undefined);
        assert.ok(result.snapshot.mass.clueIncompatible > (baseline.accounting.clueIncompatible ?? 0));
    });

    it('searchSequentialCheckpoints forwards clue pruning for every streamed checkpoint', async () => {
        const item = TEST_DATA.ITEMS.BOOK;
        const material = TEST_DATA.MATERIALS.BOOK;
        const clue = 'Protection III';
        const checkpoints = [
            { threshold: 0.05, limit: 15_000 },
            { threshold: 0.01, limit: 40_000 }
        ];
        const baselines = await Promise.all(
            checkpoints.map(checkpoint => calculateByFullSearchThenCondition(item, material, clue, checkpoint.threshold))
        );
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();
        const targetClueId = ClueValidator.validate(engine.registry, item, clue);
        const streamed: CalculationStats[] = [];
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
            const optimized = streamed[i]!;
            const baseline = baselines[i]!;
            assert.strictEqual(optimized.clue?.knownSpace, baseline.clue?.knownSpace);
            compareConditionedMaps(optimized.any, baseline.any, `${clue} sequential ${i} any`);
            compareConditionedMaps(optimized.ranks, baseline.ranks, `${clue} sequential ${i} ranks`);
            compareConditionedMaps(optimized.count, baseline.count, `${clue} sequential ${i} count`);
            compareConditionedMaps(optimized.combos, baseline.combos, `${clue} sequential ${i} combos`);
            assert.strictEqual(optimized.clue?.idAndRank, targetClueId);
            assert.strictEqual(optimized.shownClueDistribution, undefined);
            assert.ok(clueIncompatibleMass[i]! > (baseline.accounting.clueIncompatible ?? 0));
        }
    });

});
