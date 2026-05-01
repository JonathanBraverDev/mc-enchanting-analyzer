import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { ProbUtils, PRECISION } from '#utils/index.js';

describe('Engine Architectural Invariants', () => {

    it('Invariant: Mass Conservation (1.0 Total)', async () => {
        const engine = EngineFactory.create(DATA, '1.21');
        const stats = await engine.calculate('sword', 30, 'diamond', { threshold: 0.001 });

        const acc = stats.accounting;
        const total = acc.resolved + acc.pending + acc.sieved + acc.overflow + acc.capped + acc.rounding;

        // Sum should be exactly 1.0 within floating point precision of the stats object reconstruction.
        // The accounting buckets in stats are already normalized to 0..1 floats.
        assert.ok(Math.abs(total - 1.0) < 1e-15, `Mass total ${total} should be exactly 1.0`);
        assert.ok(acc.resolved > 0.9, 'Should have resolved most mass at level 30');
    });

    it('Invariant: Static Pruning Floor (No leakage between checkpoints)', async () => {
        const engine = EngineFactory.create(DATA, '1.21');

        // Run with a very high threshold (0.1).
        // Most nodes won't even be expanded, so they should be 'pending', NOT 'sieved'.
        const coarseStats = await engine.calculate('sword', 30, 'diamond', { threshold: 0.1 });

        // Sieved mass should be extremely low because it only counts branches that were
        // actually evaluated and fell below the 1e-10 floor.
        // If we used a dynamic threshold for pruning, this would be much higher (~0.2+).
        assert.ok(coarseStats.accounting.sieved < 1e-8, `Sieved mass ${coarseStats.accounting.sieved} should be near 0 at high thresholds`);
        assert.ok(coarseStats.accounting.pending > 0.01, 'Should have significant pending mass at high threshold');
    });

    it('Invariant: Legacy Book Restriction (Pre-1.7.2)', async () => {
        const engine = EngineFactory.create(DATA, '1.6.4');
        const stats = await engine.calculate('book', 30, 'book', { threshold: 0.0001 });

        // Verify that no expansion happened beyond count 1
        assert.strictEqual(stats.count[2] || 0, 0, 'Legacy books must have 0% for 2 enchants');
        assert.strictEqual(stats.count[3] || 0, 0, 'Legacy books must have 0% for 3 enchants');

        // Resolved mass should be near 1.0 because books have no conflicts at count 1
        assert.ok(stats.accounting.resolved > 0.999, 'Legacy books should resolve fully at count 1');
        assert.strictEqual(stats.accounting.overflow, 0, 'Legacy books should have 0 overflow mass');
    });

    it('Invariant: Math Buffer Integrity (Zero-Allocation Distribute)', () => {
        const prob = PRECISION;
        const weights = [10, 10, 10]; // Equal third split
        const totalWeight = 30;
        const outParts = new BigUint64Array(3);

        const remainder = ProbUtils.distributeDetailed(prob, weights, totalWeight, outParts);

        const sumParts = (outParts[0] ?? 0n) + (outParts[1] ?? 0n) + (outParts[2] ?? 0n);
        const total = sumParts + remainder;

        assert.strictEqual(total, prob, 'Sum of parts + remainder must exactly equal input prob');
        assert.strictEqual(outParts[0] ?? 0n, outParts[1] ?? 0n, 'Equal weights should yield equal parts');
        assert.strictEqual(remainder, prob % 3n, 'Remainder should match modulo');
    });

});
