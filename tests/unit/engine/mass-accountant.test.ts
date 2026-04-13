import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MassAccountant } from '../../../src/lib/engine/MassAccountant.js';
import { PRECISION } from '../../../src/lib/utils/math/ProbUtils.js';

describe('MassAccountant', () => {
    it('should initialize with zero mass in all buckets', () => {
        const accountant = new MassAccountant();
        const bk = accountant.getBookkeeping();
        assert.strictEqual(bk.resolved, 0n);
        assert.strictEqual(bk.pending, 0n);
        assert.strictEqual(bk.rounding, 0n);
    });

    it('should record mass events', () => {
        const accountant = new MassAccountant();
        accountant.record('resolved', 100n);
        accountant.record('pending', 50n);
        assert.strictEqual(accountant.getBookkeeping().resolved, 100n);
        assert.strictEqual(accountant.getBookkeeping().pending, 50n);
    });

    it('should subtract mass', () => {
        const accountant = new MassAccountant();
        accountant.record('pending', 100n);
        accountant.subtract('pending', 40n);
        assert.strictEqual(accountant.getBookkeeping().pending, 60n);
    });

    it('should calculate total mass correctly', () => {
        const accountant = new MassAccountant();
        accountant.record('resolved', 100n);
        accountant.record('pending', 200n);
        accountant.record('sieved', 50n);
        // recoveredRounding is a subset of rounding, not added to total
        accountant.record('rounding', 10n);
        accountant.record('recoveredRounding', 5n);
        
        assert.strictEqual(accountant.getTotalMass(), 360n);
    });

    it('should assert conservation', () => {
        const accountant = new MassAccountant();
        accountant.record('resolved', PRECISION);
        assert.doesNotThrow(() => accountant.assertConservation());

        accountant.record('rounding', 1n);
        assert.throws(() => accountant.assertConservation(), /Mass conservation violation/);
    });

    it('should clone correctly', () => {
        const accountant = new MassAccountant();
        accountant.record('resolved', 100n);
        const clone = accountant.clone();
        clone.record('resolved', 50n);
        
        assert.strictEqual(accountant.getBookkeeping().resolved, 100n);
        assert.strictEqual(clone.getBookkeeping().resolved, 150n);
    });
});

