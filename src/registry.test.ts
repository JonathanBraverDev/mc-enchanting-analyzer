import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from './engine.js';
import { DATA } from './data.js';

describe('Registry & Data Rules Test Suite', () => {

    describe('1. Version Availability', () => {
        it('should correctly identify Mace availability (1.21+)', () => {
            const v116 = new EnchantEngine(DATA, '1.16').registry;
            assert.strictEqual(v116.isCategoryAvailable('mace'), false, '1.16 should NOT have mace');

            const v121 = new EnchantEngine(DATA, '1.21').registry;
            assert.strictEqual(v121.isCategoryAvailable('mace'), true, '1.21 SHOULD have mace');
        });

        it('should handle Book eligibility across versions (1.3.1 - 1.7.2)', () => {
             const v131 = new EnchantEngine(DATA, '1.3.1').registry;
             assert.ok(!v131.getEligibleMaterials('book').includes('book'), '1.3.1: Book should not be enchantable');

             const v146 = new EnchantEngine(DATA, '1.4.6').registry;
             assert.ok(v146.getEligibleMaterials('book').includes('book'), '1.4.6: Book SHOULD be enchantable');
             assert.strictEqual(v146.multiEnchantBooks, false, '1.4.6: Books should be single-only');

             const v172 = new EnchantEngine(DATA, '1.7.2').registry;
             assert.strictEqual(v172.multiEnchantBooks, true, '1.7.2: Books SHOULD allow multi-enchant');
        });

        it('should correctly handle Sweeping Edge availability (1.11.1+)', () => {
            const v18 = new EnchantEngine(DATA, '1.8').registry;
            assert.ok(!v18.getCategoryPool('sword').includes('Sweeping Edge'), '1.8: Sword pool should not include Sweeping Edge');

            const v111 = new EnchantEngine(DATA, '1.11.1').registry;
            assert.ok(v111.getCategoryPool('sword').includes('Sweeping Edge'), '1.11.1: Sword pool SHOULD include Sweeping Edge');
        });

        it('should correctly handle Protection conflicts (1.14 vs 1.14.3)', () => {
            const reg114 = new EnchantEngine(DATA, '1.14').registry;
            const protId = reg114.getEnchantId('Protection')!;
            const fireProtId = reg114.getEnchantId('Fire Protection')!;

            // 1.14: No protection conflicts allowed
            assert.strictEqual(reg114.hasConflict(protId, fireProtId), false, '1.14: Protection vs Fire Protection should NOT conflict');

            // 1.14.3: ALL protections conflict
            const reg1143 = new EnchantEngine(DATA, '1.14.3').registry;
            const enchs = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];
            const ids = enchs.map(e => reg1143.getEnchantId(e)!);

            for (let i = 0; i < ids.length; i++) {
                for (let j = i + 1; j < ids.length; j++) {
                    assert.strictEqual(reg1143.hasConflict(ids[i], ids[j]), true, `1.14.3: ${enchs[i]} vs ${enchs[j]} SHOULD conflict`);
                }
            }
        });
    });

    describe('2. Item Categories & Materials', () => {
        const reg = new EnchantEngine(DATA, '1.20').registry;

        it('should return correct materials for Swords', () => {
            const mats = reg.getEligibleMaterials('sword');
            assert.ok(mats.includes('diamond'), '1.20 Sword: Expected diamond');
            assert.ok(mats.includes('netherite'), '1.20 Sword: Expected netherite');
            assert.ok(!mats.includes('book'), '1.20 Sword: Book material should be ineligible');
        });

        it('should correctly identify conflicting enchantments (Tridents)', () => {
            const riptideId = reg.getEnchantId('Riptide')!;
            const loyaltyId = reg.getEnchantId('Loyalty')!;
            const channelingId = reg.getEnchantId('Channeling')!;

            assert.strictEqual(reg.hasConflict(riptideId, loyaltyId), true, 'Riptide vs Loyalty conflict');
            assert.strictEqual(reg.hasConflict(riptideId, channelingId), true, 'Riptide vs Channeling conflict');
        });

        it('should enforce illegal enchantments on categories', () => {
            const swordPool = reg.getCategoryPool('sword');
            assert.strictEqual(swordPool.includes('Fortune'), false, 'Swords should not have Fortune');
            assert.strictEqual(swordPool.includes('Efficiency'), false, 'Swords should not have Efficiency');

            const pickaxePool = reg.getCategoryPool('pickaxe');
            assert.strictEqual(pickaxePool.includes('Sharpness'), false, 'Pickaxes should not have Sharpness');
            assert.strictEqual(pickaxePool.includes('Sweeping Edge'), false, 'Pickaxes should not have Sweeping Edge');

            const chestplatePool = reg.getCategoryPool('chestplate');
            assert.strictEqual(chestplatePool.includes('Power'), false, 'Chestplates should not have Power');
            assert.strictEqual(chestplatePool.includes('Lure'), false, 'Chestplates should not have Lure');
        });
    });
    
    describe('3. Category & Material ID Mapping', () => {
        const reg = new EnchantEngine(DATA, '1.20').registry;

        it('should assign unique Category IDs to common item types', () => {
            const categories = ["sword", "pickaxe", "axe", "shovel", "helmet", "chestplate", "leggings", "boots", "hoe", "bow"];
            const ids = new Set<number>();
            
            categories.forEach(cat => {
                const id = reg.catIdMap.get(cat) ?? 63
                assert.notStrictEqual(id, 63, `Category "${cat}" should not have the default unknown ID (63)`);
                assert.ok(!ids.has(id), `Category "${cat}" should have a unique ID, but ${id} is already taken`);
                ids.add(id);
            });
        });

        it('should assign unique Material IDs to all registered materials', () => {
            const materials = ["wood", "stone", "iron", "gold", "diamond", "netherite", "leather", "chain"];
            const ids = new Set<number>();

            materials.forEach(mat => {
                const id = reg.matIdMap.get(mat) ?? 63
                assert.notStrictEqual(id, 63, `Material "${mat}" should not have the default unknown ID (63)`);
                assert.ok(!ids.has(id), `Material "${mat}" should have a unique ID, but ${id} is already taken`);
                ids.add(id);
            });
        });
    });
});
