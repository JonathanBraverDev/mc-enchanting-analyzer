import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import {
    isItemAvailable,
    getEligibleMaterials,
    getItemPool,
    getEnchantability,
    getEnchantId,
    hasConflict,
    getItemId,
    getMaterialId,
    isMaterialEligible
} from '#core/registry.js';

describe('Registry & Data Rules Test Suite', () => {

    describe('1. Version Availability', () => {
        it('should correctly identify Mace availability (1.21+)', () => {
            const v116 = EngineFactory.createForVersion('1.16').registry;
            assert.strictEqual(isItemAvailable(v116, 'mace'), false, '1.16 should NOT have mace');

            const v121 = EngineFactory.createForVersion('1.21').registry;
            assert.strictEqual(isItemAvailable(v121, 'mace'), true, '1.21 SHOULD have mace');
        });

        it('should handle Book eligibility across versions (1.3.1 - 1.7.2)', () => {
             const v131 = EngineFactory.createForVersion('1.3.1').registry;
             assert.ok(!getEligibleMaterials(v131, 'book').includes('book'), '1.3.1: Book should not be enchantable');

             const v146 = EngineFactory.createForVersion('1.4.6').registry;
             assert.ok(getEligibleMaterials(v146, 'book').includes('book'), '1.4.6: Book SHOULD be enchantable');
             assert.strictEqual(v146.multiEnchantBooks, false, '1.4.6: Books should be single-only');

             const v172 = EngineFactory.createForVersion('1.7.2').registry;
             assert.strictEqual(v172.multiEnchantBooks, true, '1.7.2: Books SHOULD allow multi-enchant');
        });

        it('should correctly handle Sweeping Edge availability (1.11.1+)', () => {
            const v18 = EngineFactory.createForVersion('1.8').registry;
            assert.ok(!getItemPool(v18, 'sword').includes('Sweeping Edge'), '1.8: Sword pool should not include Sweeping Edge');

            const v111 = EngineFactory.createForVersion('1.11.1').registry;
            assert.ok(getItemPool(v111, 'sword').includes('Sweeping Edge'), '1.11.1: Sword pool SHOULD include Sweeping Edge');
        });

        it('should derive legacy and modern sword pools from group rules', () => {
            const v172 = EngineFactory.createForVersion('1.7.2').registry;
            const v18 = EngineFactory.createForVersion('1.8').registry;
            const v111 = EngineFactory.createForVersion('1.11.1').registry;

            assert.ok(!getItemPool(v172, 'sword').includes('Unbreaking'), '1.7.2: Sword pool should not include Unbreaking');
            assert.ok(getItemPool(v18, 'sword').includes('Unbreaking'), '1.8: Sword pool should include Unbreaking');
            assert.ok(!getItemPool(v18, 'sword').includes('Sweeping Edge'), '1.8: Sword pool should not include Sweeping Edge');
            assert.ok(getItemPool(v111, 'sword').includes('Sweeping Edge'), '1.11.1: Sword pool should include Sweeping Edge');
        });

        it('should derive bow Unbreaking membership from group rules', () => {
            const v172 = EngineFactory.createForVersion('1.7.2').registry;
            const v18 = EngineFactory.createForVersion('1.8').registry;

            assert.ok(!getItemPool(v172, 'bow').includes('Unbreaking'), '1.7.2: Bow pool should not include Unbreaking');
            assert.ok(getItemPool(v18, 'bow').includes('Unbreaking'), '1.8: Bow pool should include Unbreaking');
        });

        it('should derive armor Unbreaking and extras from group rules', () => {
            const v146 = EngineFactory.createForVersion('1.4.6').registry;
            const v172 = EngineFactory.createForVersion('1.7.2').registry;
            const v18 = EngineFactory.createForVersion('1.8').registry;

            assert.ok(!getItemPool(v146, 'chestplate').includes('Unbreaking'), '1.4.6: Chestplate should not include Unbreaking');
            assert.ok(getItemPool(v146, 'chestplate').includes('Thorns'), '1.4.6: Chestplate should include Thorns');
            assert.ok(getItemPool(v172, 'leggings').includes('Unbreaking'), '1.7.2: Leggings should include Unbreaking');
            assert.ok(getItemPool(v172, 'helmet').includes('Respiration'), '1.7.2: Helmet should include Respiration');
            assert.ok(getItemPool(v172, 'boots').includes('Feather Falling'), '1.7.2: Boots should include Feather Falling');
            assert.ok(!getItemPool(v172, 'boots').includes('Depth Strider'), '1.7.2: Boots should not include Depth Strider');
            assert.ok(getItemPool(v18, 'boots').includes('Depth Strider'), '1.8: Boots should include Depth Strider');
        });

        it('should correctly handle Netherite availability (1.16+)', () => {
             const v115 = EngineFactory.createForVersion('1.15').registry;
             assert.ok(!getEligibleMaterials(v115, 'sword').includes('netherite'), '1.15: Should not have netherite');

             const v116 = EngineFactory.createForVersion('1.16').registry;
             assert.ok(getEligibleMaterials(v116, 'sword').includes('netherite'), '1.16: SHOULD have netherite');
        });

        it('should correctly handle Copper availability (1.21.9+)', () => {
             const v121 = EngineFactory.createForVersion('1.21').registry;
             assert.ok(!getEligibleMaterials(v121, 'sword').includes('copper'), '1.21: Should not have copper');

             const v1219 = EngineFactory.createForVersion('1.21.9').registry;
             assert.ok(getEligibleMaterials(v1219, 'sword').includes('copper'), '1.21.9: SHOULD have copper');
        });

        it('should expose item availability from registry rules', () => {
            const cases = [
                { version: '1.0', available: ['sword', 'pickaxe'], unavailable: ['book', 'fishing_rod', 'trident', 'crossbow', 'hoe', 'mace', 'spear'] },
                { version: '1.4.6', available: ['book'], unavailable: ['fishing_rod'] },
                { version: '1.7.2', available: ['fishing_rod'], unavailable: ['trident'] },
                { version: '1.13', available: ['trident'], unavailable: ['crossbow'] },
                { version: '1.14', available: ['crossbow'], unavailable: ['hoe'] },
                { version: '1.16', available: ['hoe'], unavailable: ['mace'] },
                { version: '1.21', available: ['mace'], unavailable: ['spear'] },
                { version: '1.21.11', available: ['spear'], unavailable: [] }
            ];

            for (const { version, available, unavailable } of cases) {
                const registry = EngineFactory.createForVersion(version).registry;
                for (const item of available) assert.strictEqual(isItemAvailable(registry, item), true, `${version}: ${item} should be available`);
                for (const item of unavailable) assert.strictEqual(isItemAvailable(registry, item), false, `${version}: ${item} should not be available`);
            }
        });

        it('should expose material availability from registry rules', () => {
            const v10 = EngineFactory.createForVersion('1.0').registry;
            assert.deepStrictEqual(getEligibleMaterials(v10, 'sword'), ['diamond', 'gold', 'iron', 'stone', 'wood']);
            assert.ok(getEligibleMaterials(v10, 'helmet').includes('leather'), '1.0: armor should include leather');

            const v11 = EngineFactory.createForVersion('1.1').registry;
            assert.deepStrictEqual(getEligibleMaterials(v11, 'bow'), ['bow']);

            const v172 = EngineFactory.createForVersion('1.7.2').registry;
            assert.deepStrictEqual(getEligibleMaterials(v172, 'fishing_rod'), ['fishing_rod']);

            const v113 = EngineFactory.createForVersion('1.13').registry;
            assert.deepStrictEqual(getEligibleMaterials(v113, 'trident'), ['trident']);
            assert.deepStrictEqual(getEligibleMaterials(v113, 'helmet').filter(material => material === 'turtle_shell'), ['turtle_shell']);

            const v114 = EngineFactory.createForVersion('1.14').registry;
            assert.deepStrictEqual(getEligibleMaterials(v114, 'crossbow'), ['crossbow']);

            const v121 = EngineFactory.createForVersion('1.21').registry;
            assert.deepStrictEqual(getEligibleMaterials(v121, 'mace'), ['mace']);
        });

        it('should reject known materials that are not active for the item and version', async () => {
            const cases = [
                { version: '1.15', item: 'sword', material: 'netherite' },
                { version: '1.21', item: 'sword', material: 'copper' },
                { version: '1.0', item: 'helmet', material: 'turtle_shell' },
                { version: '1.0', item: 'sword', material: 'book' }
            ];

            for (const { version, item, material } of cases) {
                const engine = EngineFactory.createForVersion(version);
                const registry = engine.registry;
                assert.strictEqual(isMaterialEligible(registry, item, material), false, `${version}: ${item}/${material} should be ineligible`);
                assert.throws(
                    () => getEnchantability(registry, material, item),
                    /not available/,
                    `${version}: helper should reject ${item}/${material}`
                );
                await assert.rejects(
                    () => engine.calculate({ item, material, xp: 1, threshold: 0.5, resultsLimit: 10 }),
                    /not available/,
                    `${version}: engine should reject ${item}/${material}`
                );
            }
        });

        it('should accept materials once their item and version rules allow them', async () => {
            const cases = [
                { version: '1.16', item: 'sword', material: 'netherite' },
                { version: '1.21.9', item: 'sword', material: 'copper' },
                { version: '1.13', item: 'helmet', material: 'turtle_shell' },
                { version: '1.4.6', item: 'book', material: 'book' }
            ];

            for (const { version, item, material } of cases) {
                const engine = EngineFactory.createForVersion(version);
                const registry = engine.registry;
                assert.strictEqual(isMaterialEligible(registry, item, material), true, `${version}: ${item}/${material} should be eligible`);
                assert.doesNotThrow(() => getEnchantability(registry, material, item));
                const stats = await engine.calculate({ item, material, xp: 1, threshold: 0.5, resultsLimit: 10 });
                assert.ok(stats.accuracy >= 0, `${version}: ${item}/${material} should calculate`);
            }
        });

        it('should correctly handle Protection conflicts (1.14 vs 1.14.3)', () => {
            const reg113 = EngineFactory.createForVersion('1.13').registry;
            const prot113Id = getEnchantId(reg113, 'Protection')!;
            const fireProt113Id = getEnchantId(reg113, 'Fire Protection')!;
            assert.strictEqual(hasConflict(reg113, prot113Id, fireProt113Id), true, '1.13: Protection vs Fire Protection should conflict');

            const reg114 = EngineFactory.createForVersion('1.14').registry;
            const protId = getEnchantId(reg114, 'Protection')!;
            const fireProtId = getEnchantId(reg114, 'Fire Protection')!;

            assert.strictEqual(hasConflict(reg114, protId, fireProtId), false, '1.14: Protection vs Fire Protection should NOT conflict');

            // 1.14.3: ALL protections conflict
            const reg1143 = EngineFactory.createForVersion('1.14.3').registry;
            const enchs = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];
            const ids = enchs.map(e => getEnchantId(reg1143, e)!);

            for (let i = 0; i < ids.length; i++) {
                for (let j = i + 1; j < ids.length; j++) {
                    assert.strictEqual(hasConflict(reg1143, ids[i]!, ids[j]!), true, `1.14.3: ${enchs[i]} vs ${enchs[j]} SHOULD conflict`);
                }
            }
        });

    });

    describe('2. Items & Materials', () => {
        const reg = EngineFactory.createForVersion('1.20').registry;

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

        it('should enforce illegal enchantments on items', () => {
            const swordPool = getItemPool(reg, 'sword');
            assert.strictEqual(swordPool.includes('Fortune'), false, 'Swords should not have Fortune');
            assert.strictEqual(swordPool.includes('Efficiency'), false, 'Swords should not have Efficiency');

            const pickaxePool = getItemPool(reg, 'pickaxe');
            assert.strictEqual(pickaxePool.includes('Sharpness'), false, 'Pickaxes should not have Sharpness');
            assert.strictEqual(pickaxePool.includes('Sweeping Edge'), false, 'Pickaxes should not have Sweeping Edge');

            const chestplatePool = getItemPool(reg, 'chestplate');
            assert.strictEqual(chestplatePool.includes('Power'), false, 'Chestplates should not have Power');
            assert.strictEqual(chestplatePool.includes('Lure'), false, 'Chestplates should not have Lure');
        });
    });

    describe('3. Item & Material ID Mapping', () => {
        const reg = EngineFactory.createForVersion('1.20').registry;

        it('should assign unique item IDs to common item types', () => {
            const items = ["sword", "pickaxe", "axe", "shovel", "helmet", "chestplate", "leggings", "boots", "hoe", "bow"];
            const ids = new Set<number>();

            items.forEach(item => {
                const id = getItemId(reg, item);
                assert.notStrictEqual(id, 63, `Item "${item}" should not have the default unknown ID (63)`);
                assert.ok(!ids.has(id), `Item "${item}" should have a unique ID, but ${id} is already taken`);
                ids.add(id);
            });
        });

        it('should assign unique Material IDs to all registered materials', () => {
            const materials = ["wood", "stone", "iron", "gold", "diamond", "netherite", "leather", "chain"];
            const ids = new Set<number>();

            materials.forEach(material => {
                const id = getMaterialId(reg, material);
                assert.notStrictEqual(id, 63, `Material "${material}" should not have the default unknown ID (63)`);
                assert.ok(!ids.has(id), `Material "${material}" should have a unique ID, but ${id} is already taken`);
                ids.add(id);
            });
        });

        it('should return correct enchantability values for classic item/material pairs', () => {
            assert.strictEqual(getEnchantability(reg, 'diamond', 'sword'), 10);
            assert.strictEqual(getEnchantability(reg, 'gold', 'sword'), 22);
            assert.strictEqual(getEnchantability(reg, 'diamond', 'chestplate'), 10);
            assert.strictEqual(getEnchantability(reg, 'gold', 'chestplate'), 25);
        });

        it('should use explicit enchantability tables for armor and unique items', () => {
            const v121 = EngineFactory.createForVersion('1.21').registry;
            assert.strictEqual(getEnchantability(v121, 'turtle_shell', 'helmet'), 9);
            assert.strictEqual(getEnchantability(v121, 'book', 'book'), 1);
            assert.strictEqual(getEnchantability(v121, 'bow', 'bow'), 1);
            assert.strictEqual(getEnchantability(v121, 'crossbow', 'crossbow'), 1);
            assert.strictEqual(getEnchantability(v121, 'trident', 'trident'), 1);
            assert.strictEqual(getEnchantability(v121, 'mace', 'mace'), 15);
        });
    });
});
