import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory } from '#core/factory.js';
import { RegistryKernel } from '#lib/search/index.js';
import type { SearchPool } from '#lib/search/index.js';

describe('RegistryKernel', () => {
    it('creates stable pool signatures for equivalent modified-level pools', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const levels = Array.from({ length: 50 }, (_, i) => i + 1);
        const groups = kernel.groupLevelsByPoolSignature(levels);

        assert.ok(groups.length > 1, 'test fixture should include more than one distinct pool');
        assert.ok(groups.length < levels.length, 'adjacent levels should collapse into fewer structural pools');

        for (const group of groups) {
            for (const level of group.levels) {
                assert.strictEqual(kernel.getPool(level).signature, group.signature);
            }
        }
    });

    it('keeps different item pools structurally separate', () => {
        const registry = RegistryFactory.build('1.21.11');
        const sword = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const pickaxe = new RegistryKernel({ registry, item: 'pickaxe', material: 'diamond' });

        assert.notStrictEqual(sword.getPool(30).signature, pickaxe.getPool(30).signature);
    });

    it('keeps exact rank-variant pools separate while sharing a family signature', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const pair = findRankVariantPoolPair(kernel);

        assert.ok(pair, 'fixture should include rank-variant book pools');
        assert.notStrictEqual(pair!.a.signature, pair!.b.signature);
        assert.strictEqual(pair!.a.familySignature, pair!.b.familySignature);
    });

    it('exposes version-specific additional enchantment level decay', () => {
        const legacy = new RegistryKernel({
            registry: RegistryFactory.build('1.0'),
            item: 'sword',
            material: 'diamond'
        });
        const multiBookLegacy = new RegistryKernel({
            registry: RegistryFactory.build('1.7.2'),
            item: 'book',
            material: 'book'
        });
        const lapisPivot = new RegistryKernel({
            registry: RegistryFactory.build('1.8'),
            item: 'sword',
            material: 'diamond'
        });
        const modern = new RegistryKernel({
            registry: RegistryFactory.build('1.21.11'),
            item: 'sword',
            material: 'diamond'
        });

        assert.strictEqual(legacy.additionalEnchantmentLevelDivisor, 4);
        assert.strictEqual(multiBookLegacy.additionalEnchantmentLevelDivisor, 4);
        assert.strictEqual(lapisPivot.additionalEnchantmentLevelDivisor, 2);
        assert.strictEqual(modern.additionalEnchantmentLevelDivisor, 2);
    });

    it('includes ordered base candidates in family signatures', () => {
        const forward = RegistryFactory.buildWithMutations('1.21.11', [
            { type: 'removeEnchantableItemRule', selector: { item: 'sword', valid_from: '1.0' } },
            {
                type: 'addEnchantableItemRule',
                rule: {
                    item: 'sword',
                    valid_from: '1.0',
                    groups: ['Sharpness', 'Smite', 'Bane of Arthropods'],
                    materials: ['tool'],
                    enchantability: 'tool'
                }
            }
        ]);
        const reversed = RegistryFactory.buildWithMutations('1.21.11', [
            { type: 'removeEnchantableItemRule', selector: { item: 'sword', valid_from: '1.0' } },
            {
                type: 'addEnchantableItemRule',
                rule: {
                    item: 'sword',
                    valid_from: '1.0',
                    groups: ['Bane of Arthropods', 'Smite', 'Sharpness'],
                    materials: ['tool'],
                    enchantability: 'tool'
                }
            }
        ]);
        const forwardPool = new RegistryKernel({ registry: forward, item: 'sword', material: 'diamond' }).getPool(30);
        const reversedPool = new RegistryKernel({ registry: reversed, item: 'sword', material: 'diamond' }).getPool(30);

        assert.notStrictEqual(forwardPool.familySignature, reversedPool.familySignature);
    });

    it('projects packed pool entries needed by shared search graphs', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const pool = kernel.getPool(30);

        assert.ok(pool.entries.length > 0);
        assert.ok(pool.totalWeight > 0);
        for (const entry of pool.entries) {
            assert.ok(entry.enchantId >= 0);
            assert.ok(entry.rank >= 1);
            assert.ok(entry.weight > 0);
            assert.ok(entry.comboIndex > 0);
            assert.strictEqual(entry.idBit, 1n << BigInt(entry.enchantId));
            assert.strictEqual(entry.blocksBitset, entry.idBit | entry.conflictBitset);
            assert.notStrictEqual(entry.blocksBitset & entry.idBit, 0n);
        }
    });
});

function findRankVariantPoolPair(kernel: RegistryKernel): { a: SearchPool; b: SearchPool } | undefined {
    const byFamily = new Map<string, SearchPool[]>();
    for (let level = 1; level <= 50; level++) {
        const pool = kernel.getPool(level);
        let family = byFamily.get(pool.familySignature);
        if (!family) {
            family = [];
            byFamily.set(pool.familySignature, family);
        }
        if (!family.some(candidate => candidate.signature === pool.signature)) family.push(pool);
    }

    for (const pools of byFamily.values()) {
        if (pools.length >= 2) return { a: pools[0]!, b: pools[1]! };
    }
    return undefined;
}
