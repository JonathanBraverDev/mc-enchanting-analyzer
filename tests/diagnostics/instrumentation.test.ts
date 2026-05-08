import { test } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { EngineInstrumentation } from '#types/index.js';

test('Engine Instrumentation Collection', async () => {
    const engine = EngineFactory.createForVersion('1.21');
    const instrumentation: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false
    };

    // First run - should have many misses, 0 hits
    await engine.calculate({ item: 'leggings', xp: 30, material: 'diamond', instrumentation, threshold: 0.0001 });

    assert.ok(instrumentation.totalIterations > 0, 'Should have recorded iterations');
    assert.ok(instrumentation.poolCache.misses > 0, 'Should have pool cache misses');
    assert.ok(instrumentation.distCache.misses > 0, 'Should have dist cache misses');
    assert.ok(instrumentation.exitReason, 'Should have an exit reason');

    // Second run with same params - should hit caches
    // Reset stats cache so we actually run the calculation again, but dist/pool caches remain
    engine.resetStatsCache();
    const instrumentation2: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false
    };

    await engine.calculate({ item: 'leggings', xp: 30, material: 'diamond', instrumentation: instrumentation2, threshold: 0.0001 });

    // distCache is global to the engine, so it should hit
    assert.ok(instrumentation2.distCache.hits > 0, 'Should have dist cache hits on second run');
    // poolCache is global to the engine, so it should hit
    assert.ok(instrumentation2.poolCache.hits > 0, 'Should have pool cache hits on second run');
});

test('Frontier Cache Instrumentation (Resumption)', async () => {
    const engine = EngineFactory.createForVersion('1.21');
    const instrumentation: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false
    };

    // Run a coarse search
    await engine.calculate({ item: 'sword', xp: 30, material: 'netherite', threshold: 0.01, instrumentation });

    // Run a deep search - should hit frontierCache to resume
    engine.resetStatsCache();
    const instrumentation2: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false
    };

    await engine.calculate({ item: 'sword', xp: 30, material: 'netherite', threshold: 0.0001, instrumentation: instrumentation2 });

    assert.ok(instrumentation2.frontierCache.hits > 0, 'Should have frontier cache hits when refining');
});
