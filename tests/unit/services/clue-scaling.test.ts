import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PRECISION } from '#utils/math/ProbUtils.js';
import { SummaryService } from '#services/SummaryService.js';
import { SearchManager } from '#engine/search/SearchManager.js';

describe('Clue Conditioning Scaling diagnostics', () => {
    // Mock indexToEnchant: 1 -> Sharpness I, 2 -> Sharpness II
    const indexToEnchant = [0, 1, 2];
    const targetClueId = 1; // Sharpness I

    it('handles zero-mass clue (no combos match)', () => {
        const rawCombos = new Map<number, bigint>();
        // Combo with only Sharpness II
        rawCombos.set(2, PRECISION); 

        const tracker = new SearchManager();
        tracker.record('resolved', PRECISION); 
        const stats = SummaryService.summarizeConditioned(rawCombos as any, tracker, indexToEnchant, targetClueId);

        assert.strictEqual(stats.accounting.clueKnownSpace, 0);
        assert.strictEqual(stats.accuracy, 1); // Search was 100% complete
        assert.strictEqual(Object.keys(stats.combos).length, 0); // But 0 results match
    });

    it('handles full-mass clue (all combos match)', () => {
        const rawCombos = new Map<number, bigint>();
        // Combo with only Sharpness I
        rawCombos.set(1, PRECISION); 

        const tracker = new SearchManager();
        tracker.record('resolved', PRECISION);
        const stats = SummaryService.summarizeConditioned(rawCombos as any, tracker, indexToEnchant, targetClueId);

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

        const tracker = new SearchManager();
        tracker.record('resolved', PRECISION); // Search is 100% accurate
        const stats = SummaryService.summarizeConditioned(rawCombos as any, tracker, indexToEnchant, targetClueId);

        // pClue = 0.5
        assert.ok(Math.abs((stats.accounting.clueKnownSpace ?? 0) - 0.5) < 1e-12);
        // stats.accuracy is 1.0, so combos should scale up to sum to 1.0
        assert.ok(Math.abs((stats.combos['1'] ?? 0) - 1.0) < 1e-12);
    });

    it('preserves search uncertainty in diagnostics while results target 1.0', () => {
        const rawCombos = new Map<number, bigint>();
        rawCombos.set(1, PRECISION / 4n); // 25% compatible resolved mass

        const tracker = new SearchManager();
        tracker.record('resolved', PRECISION / 2n); // Only 50% search accuracy
        tracker.record('pending', PRECISION / 2n);
        
        const stats = SummaryService.summarizeConditioned(rawCombos as any, tracker, indexToEnchant, targetClueId);

        // pClue = 0.25 (Found 25% of absolute generation space)
        assert.ok(Math.abs((stats.accounting.clueKnownSpace ?? 0) - 0.25) < 1e-12);
        // Search accuracy reflects 50% progress
        assert.strictEqual(stats.accuracy, 0.5);
        // BUT results target 1.0 (asserting 100% certainty that IF the clue is found, this is the combo)
        assert.ok(Math.abs((stats.combos['1'] ?? 0) - 1.0) < 1e-12);
    });
});
