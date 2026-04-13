import { test } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine, EnchantEngine } from '../../src/lib/engine/index.js'; import { EngineFactory } from '../../src/lib/engine/factory.js';
import { DATA } from '../../src/lib/data/index.js';
import { EngineInstrumentation } from '../../src/lib/types/index.js';

test('Engine Instrumentation Collection', async () => {
    const engine = EngineFactory.create(DATA, '1.21');
    const instrumentation: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, checkpointSummary: [], levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false,
        checkpoints: []
    };

    // First run - should have many misses, 0 hits
    await engine.getFullStats('leggings', 30, 'diamond', { instrumentation, threshold: 0.0001 });
    
    assert.ok(instrumentation.totalIterations > 0, 'Should have recorded iterations');
    assert.ok(instrumentation.checkpoints.length > 0, 'Should have recorded mass checkpoints');
    assert.ok(instrumentation.poolCache.misses > 0, 'Should have pool cache misses');
    assert.ok(instrumentation.distCache.misses > 0, 'Should have dist cache misses');
    
    // Check checkpoint structure
    const firstCheckpoint = instrumentation.checkpoints[0];
    assert.ok(firstCheckpoint.mass >= 0.1, 'Checkpoints should start at 10% mass or higher');
    assert.ok(firstCheckpoint.iterations > 0, 'Checkpoints should record iterations');
    assert.ok(firstCheckpoint.totalIterations >= firstCheckpoint.iterations, 'Checkpoints should record global total iterations');
    assert.ok(firstCheckpoint.threshold > 0, 'Checkpoints should record threshold');
    assert.ok(instrumentation.exitReason, 'Should have an exit reason');

    // Second run with same params - should hit caches
    // Reset stats cache so we actually run the calculation again, but dist/pool caches remain
    engine.resetStatsCache();
    const instrumentation2: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, checkpointSummary: [], levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false,
        checkpoints: []
    };
    
    await engine.getFullStats('leggings', 30, 'diamond', { instrumentation: instrumentation2, threshold: 0.0001 });
    
    // distCache is global to the engine, so it should hit
    assert.ok(instrumentation2.distCache.hits > 0, 'Should have dist cache hits on second run');
    // poolCache is global to the engine, so it should hit
    assert.ok(instrumentation2.poolCache.hits > 0, 'Should have pool cache hits on second run');
});

test('Frontier Cache Instrumentation (Resumption)', async () => {
    const engine = EngineFactory.create(DATA, '1.21');
    const instrumentation: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, checkpointSummary: [], levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false,
        checkpoints: []
    };

    // Run a coarse search
    await engine.getFullStats('sword', 30, 'netherite', { threshold: 0.01, instrumentation });
    
    // Run a deep search - should hit frontierCache to resume
    engine.resetStatsCache();
    const instrumentation2: EngineInstrumentation = {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, checkpointSummary: [], levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false,
        checkpoints: []
    };
    
    await engine.getFullStats('sword', 30, 'netherite', { threshold: 0.0001, instrumentation: instrumentation2 });
    
    assert.ok(instrumentation2.frontierCache.hits > 0, 'Should have frontier cache hits when refining');
});


