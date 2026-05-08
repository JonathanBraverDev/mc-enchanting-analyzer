import { test } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { SnapshotService } from '#services/SnapshotService.js';
import { SearchResult, EngineInstrumentation } from '#types/index.js';

const EXPLORED_MASS_TARGETS = [0.1, 0.25, 0.5, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99, 0.999];

function freshInstrumentation(): EngineInstrumentation {
    return {
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
}

test('native reporting can reproduce the obsolete matrix runner payload', async () => {
    const engine = EngineFactory.createForVersion('1.21.11');
    const instrumentation = freshInstrumentation();
    instrumentation.exploredMassTargets = EXPLORED_MASS_TARGETS;
    instrumentation.exploredMassSamples = [];
    const input = {
        version: '1.21.11',
        item: 'sword',
        material: 'diamond',
        xpLevel: 30,
        clue: null
    };

    const records: Array<{
        threshold: number;
        uncertainty: number;
        pruned: number;
        roundingError: number;
        comboCount: number;
        totalIterations: number;
        exitReason: string | null;
        snapshotComboCount: number;
    }> = [];

    await engine.searchSequentialCheckpoints({
        item: input.item,
        xp: input.xpLevel,
        material: input.material,
        checkpoints: [
            { threshold: 0.0001, limit: 50_000 }
        ],
        onCheckpointComplete: (result: SearchResult) => {
            const accounting = result.tracker.mass.toPublic();
            const snapshot = SnapshotService.create(
                engine.registry,
                result.tracker,
                result.combos,
                {
                    snapshotType: 'top',
                    input,
                    refinementLevel: 'deep',
                    clue: input.clue
                },
                result.frontiers
            );

            assert.ok(snapshot.accounting, 'native snapshot should expose accounting');
            assert.strictEqual(snapshot.accounting.pending, accounting.pending);
            assert.strictEqual(snapshot.accounting.sieved, accounting.sieved);
            assert.strictEqual(snapshot.accounting.rounding, accounting.rounding);

            records.push({
                threshold: result.threshold,
                uncertainty: accounting.pending,
                pruned: accounting.sieved,
                roundingError: accounting.rounding,
                comboCount: result.combos.size,
                totalIterations: result.instrumentation?.totalIterations ?? 0,
                exitReason: result.instrumentation?.exitReason ?? null,
                snapshotComboCount: 'combos' in snapshot ? snapshot.combos.length : 0
            });
        },
        instrumentation
    });

    assert.strictEqual(records.length, 1, 'single deep search should emit one final result');

    const finalRecord = records[0];
    assert.ok(finalRecord, 'final reporting record should exist');
    assert.ok(Math.abs(finalRecord.threshold - 0.0001) < 1e-12);
    assert.ok(finalRecord.uncertainty >= 0);
    assert.ok(finalRecord.pruned >= 0);
    assert.ok(finalRecord.roundingError >= 0);
    assert.ok(finalRecord.comboCount > 0);
    assert.ok(finalRecord.snapshotComboCount > 0);
    assert.ok(finalRecord.totalIterations > 0);
    assert.ok(finalRecord.exitReason, 'native instrumentation should preserve the search exit reason');

    assert.ok(instrumentation.exploredMassSamples, 'explored-mass samples should be attached to instrumentation');
    assert.deepStrictEqual(
        [...new Set(instrumentation.exploredMassSamples.map(sample => sample.targetMass))],
        EXPLORED_MASS_TARGETS
    );
    for (const sample of instrumentation.exploredMassSamples) {
        assert.ok(sample.exploredMass >= sample.targetMass);
        assert.ok(sample.frontierProbability > 0);
        assert.ok(sample.iterations > 0);
        assert.ok(sample.totalIterations >= sample.iterations);
    }
});
