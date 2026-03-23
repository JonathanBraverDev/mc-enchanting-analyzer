import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from '../engine/index.js';
import { DATA } from '../core/data.js';
import { EngineTestUtils } from './test-utils.js';

describe('Enchantment Physical Rules Test Suite', () => {

    describe('1. Enchantment Conflicts', () => {
        const engine = new EnchantEngine(DATA, '1.20');

        it('Silk Touch and Fortune should NEVER coexist', async () => {
            const stats = await engine.getFullStats('pickaxe', 30, 'diamond', null, 0.0001);
            const human = await EngineTestUtils.getHumanStats(engine, 'pickaxe', 30, 'diamond');
            
            for (const combo of Object.keys(human.combos)) {
                const isConflict = combo.includes('Silk Touch') && combo.includes('Fortune');
                assert.ok(!isConflict, `Conflict found in combo: ${combo}`);
            }
        });

        it('Protection variants should conflict (post-1.14.3)', async () => {
            const human = await EngineTestUtils.getHumanStats(engine, 'chestplate', 30, 'diamond');
            const protNames = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];
            
            for (const combo of Object.keys(human.combos)) {
                const parts = combo.split("+").map(p => p.trim().split(" ").slice(0, -1).join(" "));
                const activeProts = parts.filter(p => protNames.includes(p));
                assert.ok(activeProts.length <= 1, `Multiple protections found in combo: ${combo}`);
            }
        });

        it('Damage enchants should conflict (Sharpness, Smite, Bane)', async () => {
            const human = await EngineTestUtils.getHumanStats(engine, 'sword', 30, 'diamond');
            const damageNames = ["Sharpness", "Smite", "Bane of Arthropods"];
            
            for (const combo of Object.keys(human.combos)) {
                const parts = combo.split("+").map(p => p.trim().split(" ").slice(0, -1).join(" "));
                const activeDamage = parts.filter(p => damageNames.includes(p));
                assert.ok(activeDamage.length <= 1, `Multiple damage enchants found in combo: ${combo}`);
            }
        });
    });

    describe('2. Material & Rank Limits', () => {
        it('Sharpness V should be impossible on Diamond at Level 30', async () => {
            const engine = new EnchantEngine(DATA, '1.20');
            const human = await EngineTestUtils.getHumanStats(engine, 'sword', 30, 'diamond');
            const hasSharpV = Object.keys(human.combos).some(c => c.includes('Sharpness V'));
            assert.ok(!hasSharpV, 'Sharpness V should not be possible on Diamond at Lvl 30');
        });

        it('Sharpness V SHOULD be possible on Gold at Level 30', async () => {
            const engine = new EnchantEngine(DATA, '1.20');
            const human = await EngineTestUtils.getHumanStats(engine, 'sword', 30, 'gold');
            const hasSharpV = !!human.ranks['Sharpness V'];
            assert.ok(hasSharpV, 'Sharpness V SHOULD be possible on Gold at Lvl 30 due to high enchantability');
        });

        it('Gold should have higher average enchantment count than Wood', async () => {
            const engine = new EnchantEngine(DATA, '1.20');
            const statsGold = await engine.getFullStats('sword', 30, 'gold');
            const statsWood = await engine.getFullStats('sword', 30, 'wood');

            const avgGold = Object.entries(statsGold.count).reduce((acc, [count, prob]) => acc + Number(count) * (prob as number), 0);
            const avgWood = Object.entries(statsWood.count).reduce((acc, [count, prob]) => acc + Number(count) * (prob as number), 0);

            assert.ok(avgGold > avgWood, `Gold average enchants (${avgGold}) should be more than Wood (${avgWood})`);
        });
    });
});
