import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ProbabilityMassTracker } from '../engine/ProbabilityMassTracker.js';
import { PRECISION } from '../utils/math/ProbUtils.js';

describe('ProbabilityMassTracker (Consolidated Mass Handling)', () => {

    it('Invariant: Diagnostic buckets are non-additive', () => {
        const tracker = new ProbabilityMassTracker();
        
        // Populate standard buckets
        tracker.record('resolved', 50n);
        tracker.record('pending', 50n);
        
        // Populate diagnostic buckets
        tracker.record('recoveredRounding', 1000n);
        tracker.record('recoveredSieved', 2000n);
        
        // Total should only be resolved + pending
        assert.strictEqual(tracker.getTotalMass(), 100n, 'Diagnostic mass must not affect getTotalMass()');
        
        const bookkeeping = tracker.getBookkeeping();
        assert.strictEqual(bookkeeping.recoveredRounding, 1000n);
        assert.strictEqual(bookkeeping.recoveredSieved, 2000n);
    });

    it('Invariant: Sum remains 100% (PRECISION) after complex operations', () => {
        const tracker = new ProbabilityMassTracker();
        
        // Simulate a full search
        tracker.record('pending', PRECISION);
        tracker.subtract('pending', 1000n);
        tracker.record('resolved', 900n);
        tracker.record('rounding', 100n);
        
        // Add some diagnostic "recovery" noise
        tracker.record('recoveredRounding', 50n);
        
        assert.strictEqual(tracker.getTotalMass(), PRECISION, 'Total mass must remain exactly PRECISION');
    });

    it('Serialization: Diagnostic buckets pass through to public stats', () => {
        const tracker = new ProbabilityMassTracker();
        tracker.record('recoveredRounding', PRECISION / 2n);
        
        const publicAcc = tracker.toPublic();
        assert.strictEqual(publicAcc.recoveredRounding, 0.5, 'Recovered mass should be visible as 0.5 in public stats');
    });

    it('Aggregation: addScaled maintains conservation invariants', () => {
        const t1 = new ProbabilityMassTracker();
        const t2 = new ProbabilityMassTracker();
        
        t2.record('resolved', PRECISION);
        
        // Add 50% of t2 to t1
        t1.addScaled(t2, PRECISION / 2n);
        
        assert.strictEqual(t1.getTotalMass(), PRECISION / 2n, 'Mass should be scaled correctly');
        assert.strictEqual(t1.getBookkeeping().resolved, PRECISION / 2n);
    });

});
