import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SearchManager } from '#engine/search/SearchManager.js';
import { PRECISION } from '#utils/math/ProbUtils.js';

describe('SearchManager Accounting', () => {
    it('should initialize with zero mass in all buckets', () => {
        const manager = new SearchManager();
        const bk = manager.getBookkeeping();
        assert.strictEqual(bk.resolved, 0n);
        assert.strictEqual(bk.pending, 0n);
        assert.strictEqual(bk.rounding, 0n);
    });

    it('should record mass events', () => {
        const manager = new SearchManager();
        manager.record('resolved', 100n);
        manager.record('pending', 50n);
        assert.strictEqual(manager.getBookkeeping().resolved, 100n);
        assert.strictEqual(manager.getBookkeeping().pending, 50n);
    });

    it('should subtract mass', () => {
        const manager = new SearchManager();
        manager.record('pending', 100n);
        manager.subtract('pending', 40n);
        assert.strictEqual(manager.getBookkeeping().pending, 60n);
    });

    it('should calculate total mass correctly', () => {
        const manager = new SearchManager();
        manager.record('resolved', 100n);
        manager.record('pending', 200n);
        manager.record('sieved', 50n);
        // recoveredRounding is a subset of rounding, not added to total implicitly (but tracked)
        manager.record('rounding', 10n);
        manager.record('recoveredRounding', 5n);
        
        assert.strictEqual(manager.getTotalMass(), 360n);
    });

    it('should addScaled correctly', () => {
        const manager = new SearchManager();
        const other = new SearchManager();
        other.record('resolved', 100n);
        
        // factor = 0.5 (PRECISION / 2)
        const factor = PRECISION / 2n;
        manager.addScaled(other, factor);
        
        assert.strictEqual(manager.getBookkeeping().resolved, 50n);
    });

    it('should clone correctly', () => {
        const manager = new SearchManager();
        manager.record('resolved', 100n);
        const clone = manager.clone();
        clone.record('resolved', 50n);
        
        assert.strictEqual(manager.getBookkeeping().resolved, 100n);
        assert.strictEqual(clone.getBookkeeping().resolved, 150n);
    });
});
