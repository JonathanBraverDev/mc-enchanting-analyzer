import { test } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { EngineInstrumentation } from '#types/index.js';

test('Engine Instrumentation Collection', async () => {
    const engine = EngineFactory.createForVersion('1.21');
    const instrumentation: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false
    };

    // First run - should have many misses, 0 hits
    await engine.getStats({ item: 'leggings', xp: 30, material: 'diamond', instrumentation, threshold: 0.0001 });

    assert.ok(instrumentation.totalIterations > 0, 'Should have recorded iterations');
    assert.ok((instrumentation.search?.runCacheMisses ?? 0) > 0, 'Should have search run cache misses');
    assert.ok(instrumentation.exitReason, 'Should have an exit reason');

    // Second run with same params should hit the resumable search-run cache.
    const instrumentation2: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false
    };

    await engine.getStats({ item: 'leggings', xp: 30, material: 'diamond', instrumentation: instrumentation2, threshold: 0.0001 });

    assert.ok((instrumentation2.search?.runCacheHits ?? 0) > 0, 'Should have search run cache hits on second run');
});

test('Search run cache instrumentation (resumption)', async () => {
    const engine = EngineFactory.createForVersion('1.21');
    const instrumentation: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false
    };

    // Run a coarse search
    await engine.getStats({ item: 'sword', xp: 30, material: 'netherite', threshold: 0.01, instrumentation });

    // Run a deeper search - should hit the resumable search-run cache
    const instrumentation2: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false
    };

    await engine.getStats({ item: 'sword', xp: 30, material: 'netherite', threshold: 0.0001, instrumentation: instrumentation2 });

    assert.ok((instrumentation2.search?.runCacheHits ?? 0) > 0, 'Should have search run cache hits when refining');
});
