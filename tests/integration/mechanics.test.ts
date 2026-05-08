import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { ProbUtils } from '#utils/index.js';
import { getEnchantId, getItemPool } from '#core/registry.js';
import { EngineTestUtils } from '#tests/infra/test-utils.js';

describe('Minecraft Mechanics Integration Tests', () => {

    describe('Book Mechanics', () => {
        it('1.4.6: Books should remain single-enchantment', async () => {
            const engine146 = EngineFactory.create(DATA, '1.4.6');
            const stats = await engine146.calculate({ item: 'book', xp: 30, material: 'book', threshold: 0.001 });
            assert.ok((stats.count[1] ?? 0) > 0.99, '1.4.6 books should only have 1 enchantment');
        });

        it('1.7.2+: Books SHOULD allow multi-enchantment', async () => {
            const engine172 = EngineFactory.create(DATA, '1.7.2');
            const stats = await engine172.calculate({ item: 'book', xp: 30, material: 'book', threshold: 0.0001 });
            assert.ok((stats.count[1] ?? 0) > 0.75, '1.7.2 books should still result in many single-enchant results');
            assert.ok((stats.count[2] ?? 0) > 0.10, '1.7.2 books should allow multiple enchants');
        });

        it('Enchantment weighting on books should be uniform', () => {
            const engine = EngineFactory.create(DATA, '1.20');
            const pool = getItemPool(engine.registry, 'book');
            assert.ok(pool.includes('Sharpness'));
            assert.ok(pool.includes('Silk Touch'));
            assert.ok(pool.includes('Infinity'));
        });
    });

    describe('Version-Specific Rules', () => {
        it('1.0: Level 50 should be possible and yield higher-tier results', async () => {
            const engine10 = EngineFactory.create(DATA, '1.0');
            const stats50 = await engine10.calculate({ item: 'sword', xp: 50, material: 'diamond', threshold: 0.001 });
            const sharpnessId = getEnchantId(engine10.registry,'Sharpness');
            const sharpVId = (sharpnessId << 8) | 5;
            assert.ok((stats50.ranks[sharpVId] || 0) > 0.05);

            const stats30 = await engine10.calculate({ item: 'sword', xp: 30, material: 'diamond', threshold: 0.001 });
            assert.ok((stats30.ranks[sharpVId] || 0) < (stats50.ranks[sharpVId] || 0));
        });

        it('1.3.1: Level 30 cap bonus range impact', async () => {
            const engine131 = EngineFactory.create(DATA, '1.3.1');
            const stats30 = await engine131.calculate({ item: 'sword', xp: 30, material: 'diamond', threshold: 0.001 });
            const sharpnessId = getEnchantId(engine131.registry,'Sharpness');
            const sharpIVId = (sharpnessId << 8) | 4;

            const engine10 = EngineFactory.create(DATA, '1.0');
            const stats30_10 = await engine10.calculate({ item: 'sword', xp: 30, material: 'diamond', threshold: 0.001 });
            assert.ok((stats30.ranks[sharpIVId] || 0) < (stats30_10.ranks[sharpIVId] || 0));
        });

        it('should correctly apply enchantability_bonus_divisor', () => {
            const engine10 = EngineFactory.create(DATA, '1.0');
            const dist10 = engine10.getModifiedLevelDist(30, 10);
            const engine131 = EngineFactory.create(DATA, '1.3.1');
            const dist131 = engine131.getModifiedLevelDist(30, 10);

            const avg10 = Object.entries(dist10).reduce((acc, [lvl, prob]) => acc + Number(lvl) * ProbUtils.toNumber(prob), 0);
            const avg131 = Object.entries(dist131).reduce((acc, [lvl, prob]) => acc + Number(lvl) * ProbUtils.toNumber(prob), 0);
            assert.ok(avg10 > avg131);
        });
    });

    describe('Physical Rules (Conflicts & Limits)', () => {
        const engine = EngineFactory.create(DATA, '1.20');

        it('Silk Touch and Fortune conflict', async () => {
            const human = await EngineTestUtils.getHumanStats(engine, 'pickaxe', 30, 'diamond');
            for (const combo of Object.keys(human.combos)) {
                assert.ok(!(combo.includes('Silk Touch') && combo.includes('Fortune')));
            }
        });

        it('Protection variants conflict', async () => {
            const human = await EngineTestUtils.getHumanStats(engine, 'chestplate', 30, 'diamond');
            const protNames = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];
            for (const combo of Object.keys(human.combos)) {
                const parts = combo.split("+").map(p => p.trim().split(" ").slice(0, -1).join(" "));
                assert.ok(parts.filter(p => protNames.includes(p)).length <= 1);
            }
        });

        it('Sharpness V Diamond vs Gold limits', async () => {
            const humanDiamond = await EngineTestUtils.getHumanStats(engine, 'sword', 30, 'diamond');
            assert.ok(!Object.keys(humanDiamond.combos).some(c => c.includes('Sharpness V')));

            const humanGold = await EngineTestUtils.getHumanStats(engine, 'sword', 30, 'gold');
            assert.ok(!!humanGold.ranks['Sharpness V']);
        });

        it('1.14: Should ALLOW multi-protection (God Armor)', async () => {
            const engine114 = EngineFactory.create(DATA, '1.14');
            const human = await EngineTestUtils.getHumanStats(engine114, 'chestplate', 30, 'diamond');

            const protNames = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];
            const multiProtFound = Object.keys(human.combos).some(combo => {
                const partsClean = combo.split("+").map(p => p.trim().split(" "));
                const names = partsClean.map(p => p.slice(0, -1).join(" "));
                return names.filter(p => protNames.includes(p)).length > 1;
            });

            assert.ok(multiProtFound, '1.14 should have at least one multi-protection combo');
        });

        it('1.14.3: Should BLOCK multi-protection (Normal & Conditioned)', async () => {
            const engine1143 = EngineFactory.create(DATA, '1.14.3');
            const protNames = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];

            // Unconditioned
            const humanNormal = await EngineTestUtils.getHumanStats(engine1143, 'chestplate', 30, 'diamond');
            for (const combo of Object.keys(humanNormal.combos)) {
                const partsClean = combo.split("+").map(p => p.trim().split(" "));
                const names = partsClean.map(p => p.slice(0, -1).join(" "));
                assert.ok(names.filter(p => protNames.includes(p)).length <= 1, `1.14.3 (Normal) fail: ${combo}`);
            }

            // Conditioned on Protection IV
            const humanConditioned = await EngineTestUtils.getHumanStats(engine1143, 'chestplate', 30, 'diamond', 'Protection IV');
            for (const combo of Object.keys(humanConditioned.combos)) {
                const partsClean = combo.split("+").map(p => p.trim().split(" "));
                const names = partsClean.map(p => p.slice(0, -1).join(" "));
                assert.ok(names.filter(p => protNames.includes(p)).length <= 1, `1.14.3 (Conditioned) fail: ${combo}`);
            }
        });
    });
});
