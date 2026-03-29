import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from '../engine/index.js';
import { DATA } from '../data/index.js';
import { EngineTestUtils } from './test-utils.js';

describe('Book Mechanics Test Suite', () => {

    it('1.4.6: Books should remain single-enchantment', async () => {
        const engine146 = new EnchantEngine(DATA, '1.4.6');
        const stats = await engine146.getFullStats('book', 30, 'book', null, 0.001);
        
        // Count 1 should be ~100% (or very close if uncertainty exists)
        assert.ok(stats.count[1] > 0.99, '1.4.6 books should only have 1 enchantment');
    });

    it('1.7.2+: Books SHOULD allow multi-enchantment (though reduced by 1)', async () => {
        const engine172 = new EnchantEngine(DATA, '1.7.2');
        const stats = await engine172.getFullStats('book', 30, 'book', null, 0.0001);
        
        // At level 30, it is very common for books to have multiple enchantments (if they rolled 3+)
        // Count 1: ~79%, Count 2: ~16%, Count 3: ~1%
        assert.ok(stats.count[1] > 0.75, '1.7.2 books should still result in many single-enchant results due to removal');
        assert.ok(stats.count[2] > 0.10, '1.7.2 books should allow multiple enchants (e.g. if 3+ were generated)');
        assert.ok((stats.count[4] || 0) < 0.001, 'Level 30 books should effectively never have 4+ enchants after removal');
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
