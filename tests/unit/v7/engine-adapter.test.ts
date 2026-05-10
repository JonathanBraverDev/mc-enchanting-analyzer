import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { CalculationStats } from '#types/index.js';

function accountingTotal(stats: CalculationStats): number {
    const a = stats.accounting;
    return a.resolved + a.clueIncompatible + a.pending + a.sieved + a.overflow + a.capped + a.rounding;
}

describe('V7 engine adapter', () => {
    it('produces CalculationStats through the normal calculate boundary', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const stats = await engine.calculate({
            engine: 'v7',
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0n,
            maxIterations: 250,
            summaryLimit: 10,
            resultsLimit: ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED
        });

        assert.ok(Object.keys(stats.combos).length > 0);
        assert.ok(stats.accuracy > 0);
        assert.ok(stats.accounting.pending > 0);
        assert.ok(Math.abs(accountingTotal(stats) - 1) < 1e-12);
        assert.strictEqual(stats.threshold, 0);
    });

    it('streams sequential checkpoints with monotonic V7 resolved mass', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();
        const accuracies: number[] = [];

        await engine.searchSequentialCheckpoints({
            engine: 'v7',
            item: 'book',
            material: 'book',
            xp: 30,
            checkpoints: [
                { threshold: 0, limit: 100 },
                { threshold: 0, limit: 300 },
                { threshold: 0, limit: 600 }
            ],
            onCheckpointComplete: result => {
                accuracies.push(result.tracker.mass.toPublic().resolved);
            }
        });

        assert.deepStrictEqual(accuracies.length, 3);
        assert.ok(accuracies[0]! > 0);
        assert.ok(accuracies[1]! > accuracies[0]!);
        assert.ok(accuracies[2]! > accuracies[1]!);
    });

    it('supports clue-conditioned requests through the V7 search path', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');

        const stats = await engine.calculate({
            engine: 'v7',
            item: 'sword',
            material: 'diamond',
            xp: 30,
            clue: 'Sharpness III',
            threshold: 0,
            maxIterations: 10_000
        });

        assert.ok(stats.clue);
        assert.strictEqual(stats.clue.idAndRank, 3);
        assert.ok(stats.clue.knownSpace > 0);
        assert.ok(stats.accounting.resolved > 0);
        assert.ok(stats.accounting.clueIncompatible > 0);
        assert.ok(Math.abs(accountingTotal(stats) - 1) < 1e-12);
        assert.ok(Object.keys(stats.combos).length > 0);
    });

    it('does not share CalculationStats cache entries between V6 and V7', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const v6 = await engine.calculate({
            engine: 'v6',
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0.00005,
            maxIterations: 30_000
        });
        const v7 = await engine.calculate({
            engine: 'v7',
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0.00005,
            maxIterations: 30_000
        });

        assert.notStrictEqual(v7, v6);
        assert.ok(v7.accuracy >= 0);
    });
});
