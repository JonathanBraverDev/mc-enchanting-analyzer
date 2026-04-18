import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SearchManager } from '#engine/search/SearchManager.js';
import { ExpansionBlueprint } from '#types/index.js';
import { PRECISION } from '#utils/index.js';

describe('SearchManager', () => {

    it('should initialize with empty mass bookkeeping', () => {
        const tracker = new SearchManager();
        const mass = tracker.toPublic();
        assert.strictEqual(mass.resolved, 0);
        assert.strictEqual(mass.pending, 0);
    });

    it('should record mass events correctly', () => {
        const tracker = new SearchManager();
        tracker.record('resolved', PRECISION / 2n);
        assert.strictEqual(tracker.toPublic().resolved, 0.5);
    });

    it('should handle cloning correctly', () => {
        const tracker = new SearchManager();
        tracker.record('resolved', PRECISION / 4n);
        const clone = tracker.clone();
        assert.strictEqual(clone.toPublic().resolved, 0.25);
        clone.record('resolved', PRECISION / 4n);
        assert.strictEqual(clone.toPublic().resolved, 0.5);
        assert.strictEqual(tracker.toPublic().resolved, 0.25);
    });

    it('should track visitation correctly', () => {
        const tracker = new SearchManager();
        tracker.markVisited(1n);
        assert.ok(tracker.has(1n));
        assert.strictEqual(tracker.getCacheSize(), 1);
    });

    it('should recover rounding residue from blueprints during mass distribution', () => {
        const tracker = new SearchManager();
        const weights = new Int32Array([10, 10]);
        
        const blueprint: ExpansionBlueprint = {
            probContinue: PRECISION,
            totalWeight: 20,
            eligibleCount: 2,
            eligibleEnchants: [1, 2] as any,
            eligibleWeights: weights,
            nextLevel: 30,
            currentCount: 1,
            currentCombo: 0 as any,
            residue: 15n
        };
        
        (tracker as any).processExpansionStep(
            0n, PRECISION, 0n, 0n,
            0n, blueprint, 
            { 
                registry: { enchantToIndex: new Map(), expansionCache: new Map() }, 
                cat: 'test',
                timing: {}, 
                resultsLimit: 100, 
                anyMass: new BigUint64Array(10), 
                rankMass: new BigUint64Array(10), 
                queue: { pushOrMerge: () => {} } 
            } as any, 
            0, [], 
            { settleMass: () => 0n }
        );

        const bk = tracker.getBookkeeping();
        assert.ok(bk.rounding > 0n || bk.resolved > 0n, 'Should have accounted for mass');
    });
});
