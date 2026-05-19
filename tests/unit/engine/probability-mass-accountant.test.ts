import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ProbabilityMassAccountant } from '#engine/search/ProbabilityMassAccountant.js';
import { PRECISION } from '#utils/math/ProbUtils.js';

describe('ProbabilityMassAccountant', () => {
    it('should initialize with zero mass in all buckets', () => {
        const tracker = new ProbabilityMassAccountant();
        const bk = tracker.getBucketUnits();
        assert.strictEqual(bk.resolved, 0n);
        assert.strictEqual(bk.pending, 0n);
        assert.strictEqual(bk.rounding, 0n);
    });

    it('should record mass events', () => {
        const tracker = new ProbabilityMassAccountant();
        tracker.record('resolved', 100n);
        tracker.record('pending', 50n);
        assert.strictEqual(tracker.getBucketUnits().resolved, 100n);
        assert.strictEqual(tracker.getBucketUnits().pending, 50n);
    });

    it('should subtract mass', () => {
        const tracker = new ProbabilityMassAccountant();
        tracker.record('pending', 100n);
        tracker.subtract('pending', 40n);
        assert.strictEqual(tracker.getBucketUnits().pending, 60n);
    });

    it('should calculate total mass correctly', () => {
        const tracker = new ProbabilityMassAccountant();
        tracker.record('resolved', 100n);
        tracker.record('pending', 200n);
        tracker.record('sieved', 50n);
        // Recovered buckets are diagnostics and not added to engine-stage total.
        tracker.record('rounding', 10n);
        tracker.record('recoveredRounding', 25n);

        assert.strictEqual(tracker.getTotalMass(), 360n);
    });

    it('should assert conservation', () => {
        const tracker = new ProbabilityMassAccountant();
        tracker.record('resolved', PRECISION);
        assert.doesNotThrow(() => tracker.assertConservation());

        tracker.record('recoveredRounding', 1n);
        assert.doesNotThrow(() => tracker.assertConservation());

        tracker.record('rounding', 1n);
        assert.throws(() => tracker.assertConservation(), /Mass conservation violation/);
    });

    it('should clone correctly', () => {
        const tracker = new ProbabilityMassAccountant();
        tracker.record('resolved', 100n);
        const clone = tracker.clone();
        clone.record('resolved', 50n);

        assert.strictEqual(tracker.getBucketUnits().resolved, 100n);
        assert.strictEqual(clone.getBucketUnits().resolved, 150n);
    });
});
