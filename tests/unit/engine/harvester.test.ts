import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ProbabilityMassTracker } from '../../../src/lib/engine/ProbabilityMassTracker.js';
import { PRECISION } from '../../../src/lib/utils/math/ProbUtils.js';
import { ExpansionBlueprint } from '../../../src/lib/types/index.js';

describe('ProbabilityMassTracker (Cache Functionality)', () => {

    it('should register expansions and report cache size', () => {
        const tracker = new ProbabilityMassTracker();
        assert.strictEqual(tracker.getCacheSize(), 0);

        const blueprint: ExpansionBlueprint = {
            probContinue: PRECISION / 2n,
            totalWeight: 10,
            eligibleCount: 1,
            eligibleEnchants: [1] as any,
            eligibleWeights: new Int32Array([10]),
            nextLevel: 30,
            currentCount: 1,
            currentCombo: 0 as any,
            currentEnchants: [],
            residue: 0n
        };

        tracker.registerExpansion(123n, blueprint);
        assert.strictEqual(tracker.getCacheSize(), 1);
        assert.strictEqual(tracker.has(123n), true);
        assert.strictEqual(tracker.get(123n), blueprint);
    });

    it('should clone with its cache intact', () => {
        const tracker = new ProbabilityMassTracker();
        const blueprint = { currentCount: 1 } as any;
        tracker.registerExpansion(100n, blueprint);

        const clone = tracker.clone();
        assert.strictEqual(clone.getCacheSize(), 1);
        assert.strictEqual(clone.has(100n), true);
        
        // Ensure isolation
        clone.registerExpansion(200n, blueprint);
        assert.strictEqual(clone.getCacheSize(), 2);
        assert.strictEqual(tracker.getCacheSize(), 1);
    });

});

