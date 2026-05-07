import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { isCategoryAvailable, getEligibleMaterials, getCategoryPool, getEnchantId, hasConflict, getCategoryId, getMaterialId } from '#core/registry.js';

describe('Registry & Data Rules Test Suite', () => {

    describe('1. Version Availability', () => {
        it('should correctly identify Mace availability (1.21+)', () => {
            const v116 = EngineFactory.create(DATA, '1.16').registry;
            assert.strictEqual(isCategoryAvailable(v116, 'mace'), false, '1.16 should NOT have mace');

            const v121 = EngineFactory.create(DATA, '1.21').registry;
            assert.strictEqual(isCategoryAvailable(v121, 'mace'), true, '1.21 SHOULD have mace');
        });

        it('should handle Book eligibility across versions (1.3.1 - 1.7.2)', () => {
             const v131 = EngineFactory.create(DATA, '1.3.1').registry;
             assert.ok(!getEligibleMaterials(v131, 'book').includes('book'), '1.3.1: Book should not be enchantable');

             const v146 = EngineFactory.create(DATA, '1.4.6').registry;
             assert.ok(getEligibleMaterials(v146, 'book').includes('book'), '1.4.6: Book SHOULD be enchantable');
             assert.strictEqual(v146.multiEnchantBooks, false, '1.4.6: Books should be single-only');

             const v172 = EngineFactory.create(DATA, '1.7.2').registry;
             assert.strictEqual(v172.multiEnchantBooks, true, '1.7.2: Books SHOULD allow multi-enchant');
        });

        it('should correctly handle Sweeping Edge availability (1.11.1+)', () => {
            const v18 = EngineFactory.create(DATA, '1.8').registry;
            assert.ok(!getCategoryPool(v18, 'sword').includes('Sweeping Edge'), '1.8: Sword pool should not include Sweeping Edge');

            const v111 = EngineFactory.create(DATA, '1.11.1').registry;
            assert.ok(getCategoryPool(v111, 'sword').includes('Sweeping Edge'), '1.11.1: Sword pool SHOULD include Sweeping Edge');
        });

        it('should correctly handle Netherite availability (1.16+)', () => {
             const v115 = EngineFactory.create(DATA, '1.15').registry;
             assert.ok(!getEligibleMaterials(v115, 'sword').includes('netherite'), '1.15: Should not have netherite');

             const v116 = EngineFactory.create(DATA, '1.16').registry;
             assert.ok(getEligibleMaterials(v116, 'sword').includes('netherite'), '1.16: SHOULD have netherite');
        });

        it('should correctly handle Copper availability (1.21.9+)', () => {
             const v121 = EngineFactory.create(DATA, '1.21').registry;
             assert.ok(!getEligibleMaterials(v121, 'sword').includes('copper'), '1.21: Should not have copper');

             const v1219 = EngineFactory.create(DATA, '1.21.9').registry;
             assert.ok(getEligibleMaterials(v1219, 'sword').includes('copper'), '1.21.9: SHOULD have copper');
        });

        it('should correctly handle Protection conflicts (1.14 vs 1.14.3)', () => {
            const reg113 = EngineFactory.create(DATA, '1.13').registry;
            const prot113Id = getEnchantId(reg113, 'Protection')!;
            const fireProt113Id = getEnchantId(reg113, 'Fire Protection')!;
            assert.strictEqual(hasConflict(reg113, prot113Id, fireProt113Id), true, '1.13: Protection vs Fire Protection should conflict');

            const reg114 = EngineFactory.create(DATA, '1.14').registry;
            const protId = getEnchantId(reg114, 'Protection')!;
            const fireProtId = getEnchantId(reg114, 'Fire Protection')!;

            assert.strictEqual(hasConflict(reg114, protId, fireProtId), false, '1.14: Protection vs Fire Protection should NOT conflict');

            // 1.14.3: ALL protections conflict
            const reg1143 = EngineFactory.create(DATA, '1.14.3').registry;
            const enchs = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];
            const ids = enchs.map(e => getEnchantId(reg1143, e)!);

            for (let i = 0; i < ids.length; i++) {
                for (let j = i + 1; j < ids.length; j++) {
                    assert.strictEqual(hasConflict(reg1143, ids[i]!, ids[j]!), true, `1.14.3: ${enchs[i]} vs ${enchs[j]} SHOULD conflict`);
                }
            }
        });
    });

    describe('2. Item Categories & Materials', () => {
        const reg = EngineFactory.create(DATA, '1.20').registry;

        it('should return correct materials for Swords', () => {
            const mats = getEligibleMaterials(reg, 'sword');
            assert.ok(mats.includes('diamond'), '1.20 Sword: Expected diamond');
            assert.ok(mats.includes('netherite'), '1.20 Sword: Expected netherite');
            assert.ok(!mats.includes('book'), '1.20 Sword: Book material should be ineligible');
        });

        it('should correctly identify conflicting enchantments (Tridents)', () => {
            const riptideId = getEnchantId(reg, 'Riptide')!;
            const loyaltyId = getEnchantId(reg, 'Loyalty')!;
            const channelingId = getEnchantId(reg, 'Channeling')!;

            assert.strictEqual(hasConflict(reg, riptideId, loyaltyId), true, 'Riptide vs Loyalty conflict');
            assert.strictEqual(hasConflict(reg, riptideId, channelingId), true, 'Riptide vs Channeling conflict');
        });

        it('should enforce illegal enchantments on categories', () => {
            const swordPool = getCategoryPool(reg, 'sword');
            assert.strictEqual(swordPool.includes('Fortune'), false, 'Swords should not have Fortune');
            assert.strictEqual(swordPool.includes('Efficiency'), false, 'Swords should not have Efficiency');

            const pickaxePool = getCategoryPool(reg, 'pickaxe');
            assert.strictEqual(pickaxePool.includes('Sharpness'), false, 'Pickaxes should not have Sharpness');
            assert.strictEqual(pickaxePool.includes('Sweeping Edge'), false, 'Pickaxes should not have Sweeping Edge');

            const chestplatePool = getCategoryPool(reg, 'chestplate');
            assert.strictEqual(chestplatePool.includes('Power'), false, 'Chestplates should not have Power');
            assert.strictEqual(chestplatePool.includes('Lure'), false, 'Chestplates should not have Lure');
        });
    });

    describe('3. Category & Material ID Mapping', () => {
        const reg = EngineFactory.create(DATA, '1.20').registry;

        it('should assign unique Category IDs to common item types', () => {
            const categories = ["sword", "pickaxe", "axe", "shovel", "helmet", "chestplate", "leggings", "boots", "hoe", "bow"];
            const ids = new Set<number>();

            categories.forEach(cat => {
                const id = getCategoryId(reg, cat);
                assert.notStrictEqual(id, 63, `Category "${cat}" should not have the default unknown ID (63)`);
                assert.ok(!ids.has(id), `Category "${cat}" should have a unique ID, but ${id} is already taken`);
                ids.add(id);
            });
        });

        it('should assign unique Material IDs to all registered materials', () => {
            const materials = ["wood", "stone", "iron", "gold", "diamond", "netherite", "leather", "chain"];
            const ids = new Set<number>();

            materials.forEach(mat => {
                const id = getMaterialId(reg, mat);
                assert.notStrictEqual(id, 63, `Material "${mat}" should not have the default unknown ID (63)`);
                assert.ok(!ids.has(id), `Material "${mat}" should have a unique ID, but ${id} is already taken`);
                ids.add(id);
            });
        });

        it('should return correct enchantability values for classic materials', () => {
            // Diamond sword enchantability is 10
            assert.strictEqual(reg.data.material_values.tools['diamond'], 10);
            // Gold sword enchantability is 22
            assert.strictEqual(reg.data.material_values.tools['gold'], 22);
        });
    });
});
