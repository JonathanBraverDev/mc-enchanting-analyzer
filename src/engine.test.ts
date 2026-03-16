import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from './engine.js';
import { DATA } from './data.js';

// Polyfill for requestAnimationFrame in Node (Sync version for tests)
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: Function) => callback(Date.now());
}

describe('EnchantEngine Baselines', () => {
    
    describe('1.8+ Mechanics', () => {
        const engine = new EnchantEngine(DATA, '1.8');

        it('should show Sharpness as possible on Diamond Swords', async () => {
            const stats = await engine.getFullStats('sword', 30, 'diamond');
            assert.ok((stats.any['Sharpness'] || 0) > 0, 'Sharpness 1.8 should be possible');
        });
    });

    describe('1.14 Protection "God Armor" window', () => {
        const engine114 = new EnchantEngine(DATA, '1.14');
        const engine1143 = new EnchantEngine(DATA, '1.14.3');

        it('1.14: protections should NOT conflict', async () => {
            const stats = await engine114.getFullStats('chestplate', 30, 'diamond', null, 0.0001);
            const combos = Object.keys(stats.combos);
            
            const protTypes = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];
            const multiProts = combos.filter(c => {
                const parts = c.split(",").map(nStr => {
                    const n = parseInt(nStr);
                    return engine114.registry.revIdMap[n >> 8];
                });
                const found = protTypes.filter(t => parts.includes(t));
                return found.length > 1;
            });

            assert.ok(multiProts.length > 0, '1.14 should allow multiple protections in one combo');
        });

        it('1.14.3: protections SHOULD conflict', async () => {
            const stats = await engine1143.getFullStats('chestplate', 30, 'diamond', null, 0.0001);
            const combos = Object.keys(stats.combos);
            
            const protTypes = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];
            const hasConflict = combos.some(c => {
                const parts = c.split(",").map(nStr => {
                    const n = parseInt(nStr);
                    return engine1143.registry.revIdMap[n >> 8];
                });
                const found = protTypes.filter(t => parts.includes(t));
                return found.length > 1;
            });

            assert.ok(!hasConflict, '1.14.3 should NOT allow multiple protections in one combo');
        });
    });

    describe('General Engine Integrity', () => {
        const engine = new EnchantEngine(DATA, '1.21');

        it('Total probability of Modified Level Distribution should be ~1.0', () => {
            const dist = engine.getModifiedLevelDist(30, 10);
            const totalProb = Object.values(dist).reduce((a, b) => a + b, 0);
            assert.ok(Math.abs(totalProb - 1.0) < 0.001);
        });

        it('Impossible seeds should return empty stats', async () => {
            const stats = await engine.getFullStats('sword', 30, 'diamond', 'Efficiency IV');
            assert.strictEqual(Object.keys(stats.combos).length, 0);
            assert.strictEqual(stats.residual, 1.0);
        });
    });

    describe('Book Enchanting Mechanics', () => {
        it('1.3.1: Books should NOT be eligible materials', () => {
            const registry = new EnchantEngine(DATA, '1.3.1').registry;
            const mats = registry.getEligibleMaterials('book');
            assert.ok(!mats.includes('book'), 'Books should not be available for enchanting in 1.3.1');
        });

        it('1.4.6: Books SHOULD be available and limit to a single enchantment', async () => {
            const engine = new EnchantEngine(DATA, '1.4.6');
            const registry = engine.registry;
            
            assert.ok(registry.getEligibleMaterials('book').includes('book'), 'Books should be available in 1.4.6');
            assert.strictEqual(registry.multiEnchantBooks, false, '1.4.6 should have multiEnchantBooks = false');

            const stats = await engine.getFullStats('book', 30, 'book');
            const combos = Object.keys(stats.combos);
            
            const hasMultiple = combos.some(c => c.split(',').length > 1);
            assert.ok(!hasMultiple, '1.4.6 books should never have multiple enchantments');
            assert.ok(combos.length > 0, '1.4.6 books should have possible enchantments');
        });

        it('1.7.2+: Books SHOULD allow multiple enchantments', async () => {
            const engine = new EnchantEngine(DATA, '1.7.2');
            assert.strictEqual(engine.registry.multiEnchantBooks, true, '1.7.2 should have multiEnchantBooks = true');

            const stats = await engine.getFullStats('book', 30, 'book', null, 0.0001);
            const combos = Object.keys(stats.combos);
            
            const hasMultiple = combos.some(c => c.split(',').length > 1);
            assert.ok(hasMultiple, '1.7.2 books should allow multiple enchantments');
        });
    });

    describe('Enchantment Version Locking', () => {
        it('Sweeping Edge should only appear in 1.11.1+', async () => {
            const engine18 = new EnchantEngine(DATA, '1.8');
            const stats18 = await engine18.getFullStats('sword', 30, 'diamond');
            assert.ok(!(stats18.any['Sweeping Edge']), 'Sweeping Edge should not exist in 1.8');

            const engine111 = new EnchantEngine(DATA, '1.11.1');
            const stats111 = await engine111.getFullStats('sword', 30, 'diamond');
            assert.ok(stats111.any['Sweeping Edge'] > 0, 'Sweeping Edge should exist in 1.11.1');
        });

        it('Mace enchantments should only appear in 1.21+', async () => {
            const engine116 = new EnchantEngine(DATA, '1.16');
            assert.ok(!engine116.registry.mergedItems['mace'], 'Mace should not be an eligible category in 1.16');

            const engine121 = new EnchantEngine(DATA, '1.21');
            const stats121 = await engine121.getFullStats('mace', 30, 'mace');
            assert.ok(stats121.any['Density'] > 0, 'Density should be possible on mace in 1.21');
        });
    });

    describe('Material and Pool Logic', () => {
        it('Gold should have better enchantment quality than Iron', async () => {
            const engine = new EnchantEngine(DATA, '1.20');
            const ironStats = await engine.getFullStats('sword', 30, 'iron');
            const goldStats = await engine.getFullStats('sword', 30, 'gold');

            // Quality metric: average number of enchantments
            const avgEnchants = (stats: any) => {
                let total = 0;
                for (const [count, prob] of Object.entries(stats.count)) {
                    total += parseInt(count) * (prob as number);
                }
                return total;
            };

            assert.ok(avgEnchants(goldStats) > avgEnchants(ironStats), 'Gold should have higher average enchantment count than iron');
        });

        it('Fortune should NOT be possible on Swords', async () => {
            const engine = new EnchantEngine(DATA, '1.20');
            const stats = await engine.getFullStats('sword', 30, 'diamond');
            assert.ok(!stats.any['Fortune'], 'Fortune should not be in the sword pool');
        });
    });

    describe('Complex Conflicts (Tridents)', () => {
        it('Riptide should conflict with Loyalty and Channeling', async () => {
            const engine = new EnchantEngine(DATA, '1.13');
            const stats = await engine.getFullStats('trident', 30, 'trident');
            
            for (const combo of Object.keys(stats.combos)) {
                const names = combo.split(',').map(n => engine.registry.revIdMap[parseInt(n) >> 8]);
                const hasRiptide = names.includes('Riptide');
                const hasLoyalty = names.includes('Loyalty');
                const hasChanneling = names.includes('Channeling');

                if (hasRiptide) {
                    assert.ok(!hasLoyalty, 'Combo cannot have Riptide and Loyalty');
                    assert.ok(!hasChanneling, 'Combo cannot have Riptide and Channeling');
                }
            }
        });
    });
});
