import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { CalculationStats, SearchResult } from '#types/index.js';

function accountingTotal(stats: CalculationStats): number {
    const a = stats.accounting;
    return a.resolved + a.clueIncompatible + a.pending + a.sieved + a.overflow + a.capped + a.rounding;
}

describe('V7 engine adapter', () => {
    it('produces CalculationStats through the normal calculate boundary', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const stats = await engine.calculate({
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

    it('exposes resolved-mass targets through the calculate boundary', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const stats = await engine.calculate({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 100_000,
            targetResolvedMass: 0.2,
            summaryLimit: 10,
            resultsLimit: ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
            useCache: false
        });

        assert.ok(stats.accuracy >= 0.2);
        assert.ok(stats.accounting.pending > 0, 'target stop should not require full resolution');
        assert.ok(Math.abs(accountingTotal(stats) - 1) < 1e-12);
    });

    it('exposes exhaustive mode through the calculate boundary', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const stats = await engine.calculate({
            item: 'mace',
            material: 'mace',
            xp: 1,
            threshold: 1,
            maxIterations: 1,
            exhaustive: true,
            summaryLimit: 10,
            resultsLimit: ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
            useCache: false
        });

        assert.strictEqual(stats.threshold, 0);
        assert.strictEqual(stats.accounting.pending, 0);
        assert.ok(stats.accounting.resolved > 0);
        assert.ok(Object.keys(stats.combos).length > 0);
        assert.ok(Math.abs(accountingTotal(stats) - 1) < 1e-12);
    });

    it('supports per-checkpoint resolved-mass targets', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();
        const snapshots: SearchResult[] = [];

        await engine.searchSequentialCheckpoints({
            item: 'book',
            material: 'book',
            xp: 30,
            checkpoints: [
                { threshold: 0, limit: 100_000, targetResolvedMass: 0.2 },
                { threshold: 0, limit: 100_000, targetResolvedMass: 0.4 }
            ],
            onCheckpointComplete: result => {
                snapshots.push(result);
            }
        });

        assert.deepStrictEqual(snapshots.length, 2);
        assert.ok(snapshots[0]!.snapshot.mass.resolved >= 0.2);
        assert.ok(snapshots[1]!.snapshot.mass.resolved >= 0.4);
        assert.ok(snapshots[1]!.snapshot.iterations > snapshots[0]!.snapshot.iterations);
        assert.ok(snapshots[1]!.snapshot.mass.pending > 0);
    });

    it('streams sequential checkpoints with monotonic V7 resolved mass', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();
        const accuracies: number[] = [];

        await engine.searchSequentialCheckpoints({
            item: 'book',
            material: 'book',
            xp: 30,
            checkpoints: [
                { threshold: 0, limit: 100 },
                { threshold: 0, limit: 300 },
                { threshold: 0, limit: 600 }
            ],
            onCheckpointComplete: result => {
                accuracies.push(result.snapshot.mass.resolved);
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

    it('projects V7 pending frontier nodes and native instrumentation through the adapter', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const instrumentation = {
            poolCache: { hits: 0, misses: 0 },
            distCache: { hits: 0, misses: 0 },
            frontierCache: { hits: 0, misses: 0 },
            totalIterations: 0,
            totalPrunedNodes: 0,
            roundingErrorEvents: 0,
            levelsProcessed: 0,
            levelsFullyResolved: 0,
            fullyResolved: false
        };

        const result = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 1,
            instrumentation
        });

        assert.ok(result.snapshot.pendingEntries.length > 0);
        assert.ok(result.snapshot.mass.pending > 0);
        assert.ok(result.instrumentation?.v7);
        assert.ok(result.instrumentation.v7.programCount > 0);
        assert.strictEqual(result.instrumentation.v7.pendingEntryCount, result.snapshot.pendingEntries.length);
        assert.ok(result.instrumentation.v7.canImprove);
    });

    it('aborts V7 checkpoint searches through the adapter', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const controller = new AbortController();
        controller.abort();

        await assert.rejects(
            () => engine.searchToCheckpoint({
                    item: 'sword',
                material: 'diamond',
                xp: 30,
                threshold: 0,
                maxIterations: 10_000,
                signal: controller.signal
            }),
            /Aborted/
        );
    });

    it('resumes V7 XP-cell runs across one-at-a-time checkpoint calls', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const first = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 50,
            instrumentation: {
                poolCache: { hits: 0, misses: 0 },
                distCache: { hits: 0, misses: 0 },
                frontierCache: { hits: 0, misses: 0 },
                totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });

        const resumed = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 10,
            instrumentation: {
                poolCache: { hits: 0, misses: 0 },
                distCache: { hits: 0, misses: 0 },
                frontierCache: { hits: 0, misses: 0 },
                totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });

        assert.strictEqual(first.instrumentation?.totalIterations, 50);
        assert.strictEqual(resumed.instrumentation?.totalIterations, 50, 'lower follow-up limit should return the already-advanced cached run');
        assert.ok((resumed.instrumentation?.v7?.runCacheHits ?? 0) >= 1);

        engine.resetCaches();
        const fresh = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 10,
            instrumentation: {
                poolCache: { hits: 0, misses: 0 },
                distCache: { hits: 0, misses: 0 },
                frontierCache: { hits: 0, misses: 0 },
                totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });

        assert.strictEqual(fresh.instrumentation?.totalIterations, 10);
    });

    it('reuses V7 structural programs across fresh XP-cell runs', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const first = await engine.searchToCheckpoint({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0,
            maxIterations: 1,
            useCache: false,
            instrumentation: {
                poolCache: { hits: 0, misses: 0 },
                distCache: { hits: 0, misses: 0 },
                frontierCache: { hits: 0, misses: 0 },
                totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });
        const firstMisses = first.instrumentation?.v7?.programCacheMisses ?? 0;

        const second = await engine.searchToCheckpoint({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0,
            maxIterations: 1,
            useCache: false,
            instrumentation: {
                poolCache: { hits: 0, misses: 0 },
                distCache: { hits: 0, misses: 0 },
                frontierCache: { hits: 0, misses: 0 },
                totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });

        assert.ok(firstMisses > 0);
        assert.ok((second.instrumentation?.v7?.programCacheHits ?? 0) >= firstMisses);
    });

});
