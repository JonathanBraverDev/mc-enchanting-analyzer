import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { SearchProcessor } from '#engine/search/SearchProcessor.js';
import { ClueSearchPolicy } from '#engine/search/ClueSearchPolicy.js';
import { DATA } from '#data/index.js';
import { ClueValidator } from '#core/clue.js';
import { SummaryService } from '#services/SummaryService.js';
import { ComboUtils } from '#utils/domain/ComboUtils.js';
import { TEST_DATA } from '#tests/infra/test-data.js';
import type { CalculationStats, PackedCombo, PackedEnchant } from '#types/index.js';

describe('Clue-aware search optimization', () => {
    const compareConditionedMaps = (actual: Record<string, number>, expected: Record<string, number>, label: string) => {
        const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
        for (const key of keys) {
            const actualValue = actual[key] ?? 0;
            const expectedValue = expected[key] ?? 0;
            assert.ok(
                Math.abs(actualValue - expectedValue) < 1e-8,
                `${label}[${key}] expected ${expectedValue}, got ${actualValue}`
            );
        }
    };

    const calculateByFullSearchThenCondition = async (
        cat: string,
        mat: string,
        clue: string,
        threshold: number
    ): Promise<CalculationStats> => {
        const engine = EngineFactory.create(DATA, '1.21.11');
        engine.resetCaches();
        const targetClueId = ClueValidator.validate(engine.registry, cat, clue);
        const fullSearch = await engine.searchToCheckpoint({
            cat,
            xp: 30,
            mat,
            threshold,
            useCache: false
        });

        return SummaryService.summarizeConditioned({
            combos: fullSearch.combos,
            tracker: fullSearch.tracker,
            indexToEnchant: engine.registry.indexToEnchant,
            targetClueId,
            frontiers: fullSearch.frontiers,
            isBook: cat === TEST_DATA.ITEMS.BOOK,
            comboLimit: 1000
        });
    };

    const calculateWithPruning = async (
        cat: string,
        mat: string,
        clue: string,
        threshold: number
    ): Promise<CalculationStats> => {
        const engine = EngineFactory.create(DATA, '1.21.11');
        engine.resetCaches();
        return engine.calculate({
            cat,
            xp: 30,
            mat,
            clue,
            threshold,
            useCache: false,
            summaryLimit: 1000
        });
    };

    const assertMatchesFullSearchConditioning = async (cat: string, mat: string, clue: string, threshold = 0.005) => {
        const baseline = await calculateByFullSearchThenCondition(cat, mat, clue, threshold);
        const optimized = await calculateWithPruning(cat, mat, clue, threshold);

        assert.strictEqual(optimized.accounting.clueKnownSpace, baseline.accounting.clueKnownSpace);
        compareConditionedMaps(optimized.any, baseline.any, `${clue} any`);
        compareConditionedMaps(optimized.ranks, baseline.ranks, `${clue} ranks`);
        compareConditionedMaps(optimized.count, baseline.count, `${clue} count`);
        compareConditionedMaps(optimized.combos, baseline.combos, `${clue} combos`);
        assert.ok(
            optimized.accounting.sieved > baseline.accounting.sieved,
            'optimized clue search should account incompatible branches as sieved mass'
        );
    };

    it('matches full-search conditioning for wrong-rank and conflicting sword branches', async () => {
        await assertMatchesFullSearchConditioning(TEST_DATA.ITEMS.SWORD, TEST_DATA.MATERIALS.DIAMOND, 'Sharpness IV');
    });

    it('matches full-search conditioning for common and rare modern book clues', async () => {
        await assertMatchesFullSearchConditioning(TEST_DATA.ITEMS.BOOK, TEST_DATA.MATERIALS.BOOK, 'Protection III', 0.01);
        await assertMatchesFullSearchConditioning(TEST_DATA.ITEMS.BOOK, TEST_DATA.MATERIALS.BOOK, 'Projectile Protection IV', 0.01);
    });

    it('filters redistributed book outcomes that lost the clue', () => {
        const target = ((1 << 8) | 1) as PackedEnchant;
        const otherA = ((2 << 8) | 1) as PackedEnchant;
        const otherB = ((3 << 8) | 1) as PackedEnchant;
        const enchantToIndex = new Map<number, number>([
            [target, 1],
            [otherA, 2],
            [otherB, 3]
        ]);
        const indexToEnchant = [0, target, otherA, otherB];
        const packed = ComboUtils.pack([target, otherA, otherB], enchantToIndex);
        const policy = ClueSearchPolicy.create({ conflictBitsets: new BigUint64Array(4) } as any, [target], target);
        const results = new Map<PackedCombo, bigint>();

        const settlement = SearchProcessor.redistributeBookProb(packed, 6n, results, policy, indexToEnchant);

        assert.strictEqual(settlement.rounding, 0n);
        assert.strictEqual(settlement.discarded, 2n);
        assert.strictEqual([...results.values()].reduce((sum, mass) => sum + mass, 0n), 4n);
        for (const combo of results.keys()) {
            assert.ok(policy.containsTargetClue(combo, indexToEnchant));
        }
    });
});
