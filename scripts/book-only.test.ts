import { it, describe } from 'node:test';
import { DATA } from '../src/data/index.js';
import { EnchantEngine } from '../src/engine/index.js';
import { ENGINE_DEFAULTS } from '../src/core/config.js';
import { SnapshotUtils } from '../src/tests/test-utils.js';

describe('Isolated 1.7.2 Book Snapshot Test', () => {
    const SNAPSHOT_LIMIT = ENGINE_DEFAULTS.MAX_RESULTS_UNBOUNDED;
    const SNAPSHOT_ITERATIONS = ENGINE_DEFAULTS.MAX_ITERATIONS_UNBOUNDED;
    const SNAPSHOT_THRESHOLD = 0.00000001;

    it('Snapshot: 1.7.2 Multi-Enchant Book @ Level 30', async () => {
        const engine = new EnchantEngine(DATA, '1.7.2');
        const stats = await engine.getFullStats('book', 30, 'book', { 
            threshold: SNAPSHOT_THRESHOLD, 
            maxIterations: SNAPSHOT_ITERATIONS, 
            summaryLimit: SNAPSHOT_LIMIT, 
            resultsLimit: SNAPSHOT_LIMIT, 
            useCache: false 
        });
        await SnapshotUtils.assertSnapshot('1.7.2_book_30_book', stats);
    });
});
