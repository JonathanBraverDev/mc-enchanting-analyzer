import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from '../engine/index.js';
import { DATA } from '../core/data.js';
import { ProbUtils } from '../utils/index.js';

describe('Mechanics Rules Test Suite', () => {

    describe('1. Version-Specific Level Caps (Legacy 50 vs Modern 30)', () => {
        it('1.0: Level 50 should be possible and yield higher-tier results', async () => {
            const engine10 = new EnchantEngine(DATA, '1.0');
            const stats50 = await engine10.getFullStats('sword', 50, 'diamond', null, 0.001);
            const sharpnessId = engine10.registry.getEnchantId('Sharpness');
            
            // Check Sharpness V (rank 5)
            const sharpVId = (sharpnessId << 8) | 5;
            assert.ok((stats50.ranks[sharpVId] || 0) > 0.05, 'Level 50 should have significant Sharpness V chance');

            // Compare with Level 30 in 1.0
            const stats30 = await engine10.getFullStats('sword', 30, 'diamond', null, 0.001);
            assert.ok((stats30.ranks[sharpVId] || 0) < (stats50.ranks[sharpVId] || 0), 'Level 50 should have better odds for top rank than level 30');
        });

        it('1.3.1: Level 30 cap should be the limit (UI level, but engine should handle it)', async () => {
            const engine131 = new EnchantEngine(DATA, '1.3.1');
            const stats30 = await engine131.getFullStats('sword', 30, 'diamond', null, 0.001);
            const sharpnessId = engine131.registry.getEnchantId('Sharpness');
            const sharpIVId = (sharpnessId << 8) | 4;
            
            // In 1.3.1, the divisor is 4, making high levels harder to reach than 1.0 (divisor 2)
            const engine10 = new EnchantEngine(DATA, '1.0');
            const stats30_10 = await engine10.getFullStats('sword', 30, 'diamond', null, 0.001);
            
            // Stats 30 in 1.3.1 should be "worse" than Stats 30 in 1.0 due to divisor and bonus range
            assert.ok((stats30.ranks[sharpIVId] || 0) < (stats30_10.ranks[sharpIVId] || 0), '1.3.1 should be harder than 1.0 for the same XP level');
        });
    });

    describe('2. Modified Level Distribution Accuracy', () => {
        it('should correctly apply enchantability_bonus_divisor', () => {
            const engine10 = new EnchantEngine(DATA, '1.0'); // Divisor 2
            const dist10 = engine10.getModifiedLevelDist(30, 10);
            
            const engine131 = new EnchantEngine(DATA, '1.3.1'); // Divisor 4
            const dist131 = engine131.getModifiedLevelDist(30, 10);

            const avg10 = Object.entries(dist10).reduce((acc, [lvl, prob]) => acc + Number(lvl) * ProbUtils.toNumber(prob), 0);
            const avg131 = Object.entries(dist131).reduce((acc, [lvl, prob]) => acc + Number(lvl) * ProbUtils.toNumber(prob), 0);

            // With divisor 2, bonus is 1 + rand(6) + rand(6) -> avg ~7. Total ~37
            // With divisor 4, bonus is 1 + rand(3) + rand(3) -> avg ~4. Total ~34
            assert.ok(avg10 > avg131, `Average modified level in 1.0 (${avg10}) should be higher than 1.3.1 (${avg131})`);
        });
    });
});
