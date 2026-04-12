import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MassAccountant } from '../engine/MassAccountant.js';
import { PRECISION } from '../utils/math/ProbUtils.js';

describe('MassAccountant Diagnostic Buckets (Phase 1)', () => {

    it('Invariant: Diagnostic buckets are non-additive', () => {
        const acc = new MassAccountant();
        
        // Populate standard buckets
        acc.record('resolved', 50n);
        acc.record('pending', 50n);
        
        // Populate diagnostic buckets
        acc.record('recoveredRounding', 1000n);
        acc.record('recoveredSieved', 2000n);
        
        // Total should only be resolved + pending
        assert.strictEqual(acc.getTotalMass(), 100n, 'Diagnostic mass must not affect getTotalMass()');
        
        const bookkeeping = acc.getBookkeeping();
        assert.strictEqual(bookkeeping.recoveredRounding, 1000n);
        assert.strictEqual(bookkeeping.recoveredSieved, 2000n);
    });

    it('Invariant: Sum remains 100% (PRECISION) after complex operations', () => {
        const acc = new MassAccountant();
        
        // Simulate a full search
        acc.record('pending', PRECISION);
        acc.subtract('pending', 1000n);
        acc.record('resolved', 900n);
        acc.record('rounding', 100n);
        
        // Add some diagnostic "recovery" noise
        acc.record('recoveredRounding', 50n);
        
        assert.strictEqual(acc.getTotalMass(), PRECISION, 'Total mass must remain exactly PRECISION');
    });

    it('Serialization: Diagnostic buckets pass through to public stats', () => {
        const acc = new MassAccountant();
        acc.record('recoveredRounding', PRECISION / 2n);
        
        const publicAcc = acc.toPublic();
        assert.strictEqual(publicAcc.recoveredRounding, 0.5, 'Recovered mass should be visible as 0.5 in public stats');
    });

    it('Aggregation: Diagnostic buckets are summed correctly', () => {
        const a1 = new MassAccountant();
        const a2 = new MassAccountant();
        
        a1.record('recoveredSieved', 100n);
        a2.record('recoveredSieved', 200n);
        
        const total = MassAccountant.aggregate([a1, a2]);
        assert.strictEqual(total.getBookkeeping().recoveredSieved, 300n, 'Aggregated recovered mass should be 300');
    });

});
