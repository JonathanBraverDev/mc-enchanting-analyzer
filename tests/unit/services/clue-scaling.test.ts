import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PRECISION } from '#utils/math/ProbUtils.js';
import { SummaryService } from '#services/SummaryService.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { NodeIdSearchFrontier } from '#engine/search/NodeIdSearchFrontier.js';
import { SearchNodeGraph } from '#engine/search/SearchNodeGraph.js';
import { ComboUtils } from '#utils/domain/ComboUtils.js';
import type { PackedCombo, PackedEnchant } from '#types/index.js';

describe('Clue Conditioning Scaling diagnostics', () => {
    // Mock indexToEnchant: 1 -> Sharpness I, 2 -> Sharpness II
    const indexToEnchant = [0, 1, 2];
    const targetClueId = 1; // Sharpness I

    const makeFrontier = (combo: PackedCombo, count: number, prob: bigint = PRECISION, scale: bigint = PRECISION) => {
        const frontier = new NodeIdSearchFrontier();
        const graph = new SearchNodeGraph();
        const nodeId = graph.createNumericNode(1, 0, 30, combo, count);
        frontier.pushOrMerge(nodeId, prob);
        return [{ frontier, graph, scale }];
    };

    it('handles zero-mass clue (no combos match)', () => {
        const rawCombos = new Map<number, bigint>();
        // Combo with only Sharpness II
        rawCombos.set(2, PRECISION);

        const tracker = new SearchStateTracker();
        tracker.mass.record('resolved', PRECISION);
        const stats = SummaryService.summarizeConditioned({ combos: rawCombos as any, tracker, indexToEnchant, targetClueId });

        assert.strictEqual(stats.accounting.clueKnownSpace, 0);
        assert.strictEqual(stats.accuracy, 1); // Search was 100% complete
        assert.strictEqual(Object.keys(stats.combos).length, 0); // But 0 results match
    });

    it('handles full-mass clue (all combos match)', () => {
        const rawCombos = new Map<number, bigint>();
        // Combo with only Sharpness I
        rawCombos.set(1, PRECISION);

        const tracker = new SearchStateTracker();
        tracker.mass.record('resolved', PRECISION);
        const stats = SummaryService.summarizeConditioned({ combos: rawCombos as any, tracker, indexToEnchant, targetClueId });

        // pClue should be 1.0
        assert.ok(Math.abs((stats.accounting.clueKnownSpace ?? 0) - 1.0) < 1e-12);
        assert.strictEqual(stats.accuracy, 1);
        // combos should sum to 1.0
        assert.ok(Math.abs((stats.combos['1'] ?? 0) - 1.0) < 1e-12);
    });

    it('calculates partial-mass clue correctly and scales to search accuracy', () => {
        const rawCombos = new Map<number, bigint>();
        // 50% chance for a combo with Sharpness I
        // 50% chance for a combo with Sharpness II
        rawCombos.set(1, PRECISION / 2n);
        rawCombos.set(2, PRECISION / 2n);

        const tracker = new SearchStateTracker();
        tracker.mass.record('resolved', PRECISION); // Search is 100% accurate
        const stats = SummaryService.summarizeConditioned({ combos: rawCombos as any, tracker, indexToEnchant, targetClueId });

        // pClue = 0.5
        assert.ok(Math.abs((stats.accounting.clueKnownSpace ?? 0) - 0.5) < 1e-12);
        // stats.accuracy is 1.0, so combos should scale up to sum to 1.0
        assert.ok(Math.abs((stats.combos['1'] ?? 0) - 1.0) < 1e-12);
    });

    it('preserves search uncertainty in diagnostics while results target 1.0', () => {
        const rawCombos = new Map<number, bigint>();
        rawCombos.set(1, PRECISION / 4n); // 25% compatible resolved mass

        const tracker = new SearchStateTracker();
        tracker.mass.record('resolved', PRECISION / 2n); // Only 50% search accuracy
        tracker.mass.record('pending', PRECISION / 2n);

        const stats = SummaryService.summarizeConditioned({ combos: rawCombos as any, tracker, indexToEnchant, targetClueId });

        // pClue = 0.25 (Found 25% of absolute generation space)
        assert.ok(Math.abs((stats.accounting.clueKnownSpace ?? 0) - 0.25) < 1e-12);
        // Search accuracy reflects 50% progress
        assert.strictEqual(stats.accuracy, 0.5);
        // BUT results target 1.0 (asserting 100% certainty that IF the clue is found, this is the combo)
        assert.ok(Math.abs((stats.combos['1'] ?? 0) - 1.0) < 1e-12);
    });

    it('includes pending frontier mass in clue-known space', () => {
        const enchantToIndex = new Map<number, number>([
            [targetClueId, 1],
            [2, 2]
        ]);
        const packed = ComboUtils.pack([targetClueId as PackedEnchant, 2 as PackedEnchant], enchantToIndex);
        const frontiers = makeFrontier(packed, 2, PRECISION / 2n);

        const tracker = new SearchStateTracker();
        tracker.mass.record('pending', PRECISION / 2n);

        const stats = SummaryService.summarizeConditioned({
            combos: new Map(),
            tracker,
            indexToEnchant,
            targetClueId,
            frontiers
        });

        assert.ok(Math.abs((stats.accounting.clueKnownSpace ?? 0) - 0.25) < 1e-12);
        assert.ok(Math.abs(Number(stats.combos[packed.toString(16)] ?? 0) - 1.0) < 1e-12);
    });

    it('includes pending book frontier mass in clue-known space', () => {
        const enchantC = 3 as PackedEnchant;
        const bookIndexToEnchant = [0, targetClueId, 2, enchantC];
        const enchantToIndex = new Map<number, number>([
            [targetClueId, 1],
            [2, 2],
            [enchantC, 3]
        ]);
        const packed = ComboUtils.pack([targetClueId as PackedEnchant, 2 as PackedEnchant, enchantC], enchantToIndex);
        const frontiers = makeFrontier(packed, 3, PRECISION);

        const tracker = new SearchStateTracker();
        tracker.mass.record('pending', PRECISION);

        const stats = SummaryService.summarizeConditioned({
            combos: new Map(),
            tracker,
            indexToEnchant: bookIndexToEnchant,
            targetClueId,
            frontiers,
            isBook: true
        });

        assert.ok(Math.abs((stats.accounting.clueKnownSpace ?? 0) - (1 / 3)) < 1e-12);
        assert.ok(Math.abs(Number(stats.combos[packed.toString(16)] ?? 0) - 1.0) < 1e-12);
    });
});
