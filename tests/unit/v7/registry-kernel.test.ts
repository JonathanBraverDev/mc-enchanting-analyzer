import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory, RegistryKernel } from '#lib/index.js';

describe('V7 RegistryKernel', () => {
    it('creates stable pool signatures for equivalent modified-level pools', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const levels = Array.from({ length: 50 }, (_, i) => i + 1);
        const groups = kernel.getPoolGroups(levels);

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

    it('projects packed pool entries needed by shared search programs', () => {
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
        }
    });
});
