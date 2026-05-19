import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { getDefaultStatsCheckpoint, getSearchCheckpointForRefinement } from '#core/config.js';
import { EnchantStats, EngineInstrumentation, SearchResult } from '#types/index.js';

function accountingTotal(stats: EnchantStats): number {
    const a = stats.accounting;
    return a.resolved + a.clueIncompatible + a.pending + a.sieved + a.overflow + a.capped + a.rounding;
}

function snapshotAccountingTotal(result: SearchResult): number {
    const a = result.snapshot.mass;
    return a.resolved + a.clueIncompatible + a.pending + a.sieved + a.overflow + a.capped + a.rounding;
}

function createInstrumentation(): EngineInstrumentation {
    return {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        totalIterations: 0,
        totalPrunedNodes: 0,
        roundingErrorEvents: 0,
        levelsProcessed: 0,
        levelsFullyResolved: 0,
        fullyResolved: false
    };
}

describe('Search execution service', () => {
    it('keeps the concrete SearchRun backend as the default execution path', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const instrumentation = createInstrumentation();

        const result = await engine.searchToCheckpoint({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0,
            maxIterations: 1,
            instrumentation
        });

        assert.strictEqual(result.instrumentation?.search?.backend, 'concrete');
        assert.ok(result.snapshot.pendingEntries.length > 0);
    });

    it('routes checkpoint searches through Plex when explicitly requested', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const instrumentation = createInstrumentation();

        const result = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 1,
            searchBackend: 'plex',
            instrumentation
        });

        assert.strictEqual(result.instrumentation?.search?.backend, 'plex');
        assert.strictEqual(result.instrumentation?.exitReason, 'iterations');
        assert.ok(result.snapshot.pendingEntries.length > 0);
        assert.ok(result.instrumentation.search.pendingEntryCount > (result.instrumentation.search.plexStructuralPendingEntryCount ?? 0));
        assert.ok(Math.abs(snapshotAccountingTotal(result) - 1) < 1e-12);
    });

    it('resumes cached Plex runs across one-at-a-time checkpoint calls', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const first = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 50,
            searchBackend: 'plex',
            instrumentation: createInstrumentation()
        });
        const resumed = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 10,
            searchBackend: 'plex',
            instrumentation: createInstrumentation()
        });

        assert.strictEqual(first.instrumentation?.search?.backend, 'plex');
        assert.strictEqual(first.instrumentation?.totalIterations, 50);
        assert.strictEqual(resumed.instrumentation?.totalIterations, 50);
        assert.ok((resumed.instrumentation?.search?.runCacheHits ?? 0) >= 1);
    });

    it('supports Plex through the public stats API while preserving compatible accounting', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const stats = await engine.getStats({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0,
            maxIterations: 250,
            summaryLimit: 10,
            searchBackend: 'plex',
            instrumentation: createInstrumentation()
        });

        assert.strictEqual(stats.instrumentation?.search?.backend, 'plex');
        assert.ok(Object.keys(stats.combos).length > 0);
        assert.ok(stats.accounting.pending > 0);
        assert.ok(Math.abs(accountingTotal(stats) - 1) < 1e-12);
    });

    it('produces EnchantStats through the public stats API', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const stats = await engine.getStats({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0n,
            maxIterations: 250,
            summaryLimit: 10,
        });

        assert.ok(Object.keys(stats.combos).length > 0);
        assert.ok(stats.accuracy > 0);
        assert.ok(stats.accounting.pending > 0);
        assert.ok(Math.abs(accountingTotal(stats) - 1) < 1e-12);
        assert.strictEqual(stats.threshold, 0);
    });

    it('exposes exhaustive mode through the public stats API', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const stats = await engine.getStats({
            item: 'mace',
            material: 'mace',
            xp: 1,
            threshold: 1,
            maxIterations: 1,
            exhaustive: true,
            summaryLimit: 10,
            useCache: false
        });

        assert.strictEqual(stats.threshold, 0);
        assert.strictEqual(stats.accounting.pending, 0);
        assert.ok(stats.accounting.resolved > 0);
        assert.ok(Object.keys(stats.combos).length > 0);
        assert.ok(Math.abs(accountingTotal(stats) - 1) < 1e-12);
    });

    it('uses the default stats checkpoint for simple stats calls', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const checkpoint = getDefaultStatsCheckpoint(false);

        const instrumentation = {
            poolCache: { hits: 0, misses: 0 },
            distCache: { hits: 0, misses: 0 },
            totalIterations: 0,
            totalPrunedNodes: 0,
            roundingErrorEvents: 0,
            levelsProcessed: 0,
            levelsFullyResolved: 0,
            fullyResolved: false
        };
        const stats = await engine.getStats({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            summaryLimit: 10,
            instrumentation
        });

        assert.strictEqual(stats.threshold, checkpoint.threshold);
        assert.ok((stats.instrumentation?.totalIterations ?? 0) <= checkpoint.limit);
    });

    it('requires uncappedResults for summary limits above the normal export cap', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        await assert.rejects(
            () => engine.getStats({
                item: 'sword',
                material: 'diamond',
                xp: 30,
                summaryLimit: ENGINE_LIMITS.RESULT_ENTRY_SAFETY_CAP + 1
            }),
            /uncappedResults/
        );

        const stats = await engine.getStats({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            summaryLimit: ENGINE_LIMITS.RESULT_ENTRY_SAFETY_CAP + 1,
            uncappedResults: true
        });
        assert.ok(Object.keys(stats.combos).length > 0);
    });

    it('omits classified-mass targets from named refinement checkpoints by default', () => {
        const checkpoint = getSearchCheckpointForRefinement('ultra', true);

        assert.strictEqual(checkpoint.targetClassifiedMass, undefined);
    });

    it('supports per-checkpoint classified-mass targets', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();
        const snapshots: SearchResult[] = [];
        const instrumentation = {
            poolCache: { hits: 0, misses: 0 },
            distCache: { hits: 0, misses: 0 },
                totalIterations: 0,
            totalPrunedNodes: 0,
            roundingErrorEvents: 0,
            levelsProcessed: 0,
            levelsFullyResolved: 0,
            fullyResolved: false
        };

        await engine.searchSequentialCheckpoints({
            item: 'book',
            material: 'book',
            xp: 30,
            checkpoints: [
                { threshold: 0, limit: 100_000, targetClassifiedMass: 0.2 },
                { threshold: 0, limit: 100_000, targetClassifiedMass: 0.4 }
            ],
            instrumentation,
            onCheckpointComplete: result => {
                snapshots.push(result);
            }
        });

        assert.deepStrictEqual(snapshots.length, 2);
        assert.ok((1 - snapshots[0]!.snapshot.mass.pending) >= 0.2);
        assert.ok((1 - snapshots[1]!.snapshot.mass.pending) >= 0.4);
        assert.ok(snapshots[1]!.snapshot.iterations > snapshots[0]!.snapshot.iterations);
        assert.ok(snapshots[1]!.snapshot.mass.pending > 0);
        assert.strictEqual(snapshots[0]!.instrumentation?.exitReason, 'mass');
        assert.strictEqual(snapshots[1]!.instrumentation?.exitReason, 'mass');
    });

    it('supports direct classified-mass targets and reports the last expanded node mass', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const result = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            targetClassifiedMass: 0.25,
            instrumentation: {
                poolCache: { hits: 0, misses: 0 },
                distCache: { hits: 0, misses: 0 },
                totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });

        assert.ok((1 - result.snapshot.mass.pending) >= 0.25);
        assert.strictEqual(result.instrumentation?.exitReason, 'mass');
        assert.ok(result.snapshot.lastExpandedMass > 0n);
        assert.ok((result.instrumentation?.search?.lastExpandedMass ?? 0) > 0);
    });

    it('rejects public non-exhaustive searches without any bounded stop condition', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        await assert.rejects(
            () => engine.searchToCheckpoint({
                item: 'book',
                material: 'book',
                xp: 30,
                threshold: 0
            }),
            /no bounded stop condition/
        );
    });

    it('rejects NaN probability controls with descriptive validation errors', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        await assert.rejects(
            () => engine.searchToCheckpoint({
                item: 'book',
                material: 'book',
                xp: 30,
                threshold: Number.NaN,
                maxIterations: 1
            }),
            /Invalid threshold: NaN\. Threshold must be between 0 and 1\.0\./
        );

        await assert.rejects(
            () => engine.searchToCheckpoint({
                item: 'book',
                material: 'book',
                xp: 30,
                targetClassifiedMass: Number.NaN
            }),
            /Invalid targetClassifiedMass: NaN\. Must be between 0 and 1\.0\./
        );

        await assert.rejects(
            () => engine.searchSequentialCheckpoints({
                item: 'book',
                material: 'book',
                xp: 30,
                checkpoints: [{ threshold: Number.NaN, limit: 1 }],
                onCheckpointComplete: () => {}
            }),
            /Invalid checkpoint threshold: NaN\. Threshold must be between 0 and 1\.0\./
        );

        await assert.rejects(
            () => engine.searchSequentialCheckpoints({
                item: 'book',
                material: 'book',
                xp: 30,
                checkpoints: [{ threshold: 0, limit: 1, targetClassifiedMass: Number.NaN }],
                onCheckpointComplete: () => {}
            }),
            /Invalid checkpoint targetClassifiedMass: NaN\. Must be between 0 and 1\.0\./
        );
    });

    it('streams sequential checkpoints with monotonic resolved mass', async () => {
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

    it('supports clue-conditioned requests through the search path', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');

        const stats = await engine.getStats({
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

    it('projects pending frontier nodes and search instrumentation through the search execution service', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const instrumentation = {
            poolCache: { hits: 0, misses: 0 },
            distCache: { hits: 0, misses: 0 },
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
        assert.ok(result.instrumentation?.search);
        assert.ok(result.instrumentation.search.graphCount > 0);
        assert.strictEqual(result.instrumentation.search.pendingEntryCount, result.snapshot.pendingEntries.length);
        assert.ok(result.instrumentation.search.canImprove);
    });

    it('aborts checkpoint searches through the search execution service', async () => {
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

    it('resumes XP-cell runs across one-at-a-time checkpoint calls', async () => {
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
        assert.ok((resumed.instrumentation?.search?.runCacheHits ?? 0) >= 1);

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

    it('reuses structural graphs across fresh XP-cell runs', async () => {
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
                        totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });
        const firstMisses = first.instrumentation?.search?.graphCacheMisses ?? 0;

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
                        totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });

        assert.ok(firstMisses > 0);
        assert.ok((second.instrumentation?.search?.graphCacheHits ?? 0) >= firstMisses);
    });

});
