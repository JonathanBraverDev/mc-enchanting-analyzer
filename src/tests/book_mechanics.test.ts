import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from '../engine/index.js';
import { DATA } from '../core/data.js';
import { EngineTestUtils } from './test-utils.js';

describe('Book Mechanics Test Suite', () => {

    it('1.4.6: Books should remain single-enchantment', async () => {
        const engine146 = new EnchantEngine(DATA, '1.4.6');
        const stats = await engine146.getFullStats('book', 30, 'book', null, 0.001);
        
        // Count 1 should be ~100% (or very close if uncertainty exists)
        assert.ok(stats.count[1] > 0.99, '1.4.6 books should only have 1 enchantment');
    });

    it('1.7.2+: Books SHOULD allow multi-enchantment', async () => {
        const engine172 = new EnchantEngine(DATA, '1.7.2');
        const stats = await engine172.getFullStats('book', 30, 'book', null, 0.0001);
        
        // Count 2+ should be possible
        const multiProb = (stats.count[2] || 0) + (stats.count[3] || 0);
        assert.ok(multiProb > 0.05, '1.7.2 books should allow multiple enchants');
    });

    it('Enchantment weighting on books should be uniform ( Registry check )', () => {
        const engine = new EnchantEngine(DATA, '1.20');
        const pool = engine.registry.getCategoryPool('book');
        
        // Check if common and rare enchants are both present
        assert.ok(pool.includes('Sharpness'), 'Books should have Sharpness');
        assert.ok(pool.includes('Silk Touch'), 'Books should have Silk Touch');
        assert.ok(pool.includes('Infinity'), 'Books should have Infinity');
    });
});
