import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from './engine.js';
import { DATA } from './data.js';

// Polyfill for requestAnimationFrame in Node (Sync version for tests)
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: Function) => callback(Date.now());
}

describe('Enchantment Engine Test Suite', () => {

    describe('1. Core Engine Logic', () => {
        const engine = new EnchantEngine(DATA, '1.21');

        it('should maintain total probability of Modified Level Distribution near 1.0', () => {
            const dist = engine.getModifiedLevelDist(30, 10);
            const totalProb = Object.values(dist).reduce((a, b) => a + b, 0);
            assert.ok(Math.abs(totalProb - 1.0) < 0.001);
        });

        it('should NOT return "X undefined" when no enchants are possible', async () => {
            const stats = await engine.getFullStats('sword', 1, 'diamond');
            // Check that a key with "undefined" doesn't exist.
            const hasUndefined = Object.keys(stats.combos).some(c => c.includes('undefined')) ||
                                Object.keys(stats.ranks).some(r => r.includes('undefined'));
            assert.ok(!hasUndefined, '"undefined" should not appear in results');
        });
    });

    describe('2. Version Compatibility & Historical Changes', () => {
        it('1.11.1+: Sweeping Edge should only appear in valid versions', async () => {
            const v18 = new EnchantEngine(DATA, '1.8');
            const s18 = await v18.getFullStats('sword', 30, 'diamond');
            assert.ok(!s18.any['Sweeping Edge']);

            const v111 = new EnchantEngine(DATA, '1.11.1');
            const s111 = await v111.getFullStats('sword', 30, 'diamond');
            assert.ok(s111.any['Sweeping Edge'] > 0);
        });

        it('1.14 vs 1.14.3: Protection conflict window', async () => {
            const e114 = new EnchantEngine(DATA, '1.14');
            const e1143 = new EnchantEngine(DATA, '1.14.3');
            const protTypes = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];

            const s114 = await e114.getFullStats('chestplate', 30, 'diamond', null, 0.0001);
            const multi114 = Object.keys(s114.combos).filter(c => {
                const names = c.split("+").map(f => f.split(" ").slice(0, -1).join(" "));
                return protTypes.filter(t => names.includes(t)).length > 1;
            });
            assert.ok(multi114.length > 0, '1.14 should allow multi-protection');

            const s1143 = await e1143.getFullStats('chestplate', 30, 'diamond', null, 0.0001);
            const multi1143 = Object.keys(s1143.combos).some(c => {
                const names = c.split("+").map(f => f.split(" ").slice(0, -1).join(" "));
                return protTypes.filter(t => names.includes(t)).length > 1;
            });
            assert.ok(!multi1143, '1.14.3 should block multi-protection');
        });

        it('1.21+: Mace exclusive enchantments', async () => {
            const v116 = new EnchantEngine(DATA, '1.16');
            assert.ok(!v116.registry.mergedItems['mace']);

            const v121 = new EnchantEngine(DATA, '1.21');
            const s121 = await v121.getFullStats('mace', 30, 'mace');
            assert.ok(s121.any['Density'] > 0);
        });
    });

    describe('3. Item Categories & Material Rules', () => {
        const engine = new EnchantEngine(DATA, '1.20');

        it('Books: Availability and multiplicity rules (1.3.1, 1.4.6, 1.7.2)', async () => {
            // 1.3.1: Not eligible
            const reg131 = new EnchantEngine(DATA, '1.3.1').registry;
            assert.ok(!reg131.getEligibleMaterials('book').includes('book'));

            // 1.4.6: Single only
            const v146 = new EnchantEngine(DATA, '1.4.6');
            const s146 = await v146.getFullStats('book', 30, 'book');
            assert.ok(!Object.keys(s146.combos).some(c => c.split('+').length > 1));

            // 1.7.2: Multi allowed
            const v172 = new EnchantEngine(DATA, '1.7.2');
            const s172 = await v172.getFullStats('book', 30, 'book', null, 0.0001);
            assert.ok(Object.keys(s172.combos).some(c => c.split('+').length > 1));
        });

        it('Tridents: Riptide/Loyalty/Channeling mutual exclusion', async () => {
            const v113 = new EnchantEngine(DATA, '1.13');
            const stats = await v113.getFullStats('trident', 30, 'trident');
            for (const combo of Object.keys(stats.combos)) {
                const names = combo.split('+');
                if (names.includes('Riptide')) {
                    const hasLoyal = names.some(n => n.startsWith('Loyalty'));
                    const hasChan = names.some(n => n.startsWith('Channeling'));
                    assert.ok(!hasLoyal && !hasChan, 'Riptide should conflict with Loyalty/Channeling');
                }
            }
        });

        it('Materials: Gold quality vs Iron', async () => {
            const iron = await engine.getFullStats('sword', 30, 'iron');
            const gold = await engine.getFullStats('sword', 30, 'gold');
            const score = (s: any) => Object.entries(s.count).reduce((a, [c, p]) => a + Number(c) * (p as number), 0);
            assert.ok(score(gold) > score(iron));
        });

        it('Category Constraints: Fortune should not appear on Swords', async () => {
            const stats = await engine.getFullStats('sword', 30, 'diamond');
            assert.ok(!stats.any['Fortune']);
        });
    });

    describe('4. Search Algorithm & Accuracy', () => {
        const engine = new EnchantEngine(DATA, '1.20');

        it('Progressive Refinement Parity: Resumed search should match fresh search', async () => {
            const standard = await engine.getFullStats('book', 30, 'book', null, 0.001);
            engine.comboCache.clear();
            engine.statsCache.clear();
            await engine.getFullStats('book', 30, 'book', null, 0.05); // Coarse
            const resumed = await engine.getFullStats('book', 30, 'book', null, 0.001); // Resume
            
            const keysS = Object.keys(standard.any).sort().slice(0, 5);
            const keysR = Object.keys(resumed.any).sort().slice(0, 5);
            assert.deepStrictEqual(keysS, keysR);
        });

        it('Delayed Level Decay & Pool Persistence', async () => {
            const stats = await engine.getFullStats('pickaxe', 30, 'diamond', null, 0.0001);
            
            // Pool Persistence: Efficiency IV in slot 3+
            const hasEffIVDeep = Object.keys(stats.combos)
                .filter(c => c.split('+').length >= 3)
                .some(c => c.includes("Efficiency IV"));
            assert.ok(hasEffIVDeep);

            // Level Decay Logic verification (Distribution check)
            assert.ok(stats.count["2"] > 0.1, "Double enchants should be significant");
            assert.ok((stats.count["1"] || 0) + (stats.count["2"] || 0) + (stats.count["3"] || 0) > 0.9);
        });

        it('God Pick verification (Efficiency IV + Fortune III + Unbreaking III)', async () => {
            const stats = await engine.getFullStats('pickaxe', 30, 'diamond', null, 0.0001);
            const target = ["Efficiency IV", "Fortune III", "Unbreaking III"];
            let prob = 0;
            for (const [c, p] of Object.entries(stats.combos)) {
                const parts = c.split('+');
                if (target.every(t => parts.includes(t))) prob += p;
            }
            assert.ok(prob > 0.0001);
        });
    });
});

