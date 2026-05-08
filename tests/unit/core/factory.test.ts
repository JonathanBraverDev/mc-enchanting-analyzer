import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    getEligibleMaterials,
    getEnchantId,
    getItemPool,
    hasConflict,
    isItemAvailable
} from '#core/registry.js';
import { RegistryFactory } from '#core/factory.js';
import { EngineFactory } from '#engine/factory.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import type { RegistryMutation } from '#types/index.js';

describe('EngineFactory', () => {
    it('builds the bundled vanilla registry by version', () => {
        const registry = RegistryFactory.build('1.21.11');

        assert.strictEqual(registry.version, '1.21.11');
        assert.strictEqual(registry.source, 'vanilla');
        assert.strictEqual('mutations' in registry, false);
        assert.ok(isItemAvailable(registry, 'book'));
    });

    it('applies a single vanilla-data mutation without changing future vanilla builds', () => {
        const custom = RegistryFactory.buildWithMutations('1.21.11', {
            type: 'removeEnchantableItemRule',
            selector: { item: 'mace', valid_from: '1.21' }
        });
        const vanilla = RegistryFactory.build('1.21.11');

        assert.strictEqual(custom.source, 'mutated');
        assert.deepStrictEqual(custom.mutations, [
            {
                type: 'removeEnchantableItemRule',
                selector: { item: 'mace', valid_from: '1.21' }
            }
        ]);
        assert.strictEqual(isItemAvailable(custom, 'mace'), false);
        assert.strictEqual(isItemAvailable(vanilla, 'mace'), true);
    });

    it('keeps mutated registry provenance separate from caller-owned mutation objects', () => {
        const originalSelector = { item: 'mace', valid_from: '1.21' };
        const mutations: RegistryMutation[] = [
            {
                type: 'removeEnchantableItemRule',
                selector: originalSelector
            }
        ];

        const custom = RegistryFactory.buildWithMutations('1.21.11', mutations);
        originalSelector.item = 'book';
        mutations[0] = {
            type: 'removeMaterialRule',
            selector: { material: 'diamond', valid_from: '1.0' }
        };

        assert.deepStrictEqual(custom.mutations, [
            {
                type: 'removeEnchantableItemRule',
                selector: { item: 'mace', valid_from: '1.21' }
            }
        ]);
    });

    it('applies mutation arrays to rule tables', () => {
        const custom = RegistryFactory.buildWithMutations('1.15', [
            {
                type: 'addMaterialRule',
                rule: { material: 'netherite', valid_from: '1.15', valid_until: '1.16' }
            },
            {
                type: 'addEnchantmentGroupRule',
                rule: {
                    group: 'sword_pool',
                    enchantments: ['Efficiency'],
                    valid_from: '1.15',
                    valid_until: '1.16'
                }
            }
        ]);

        assert.ok(getEligibleMaterials(custom, 'sword').includes('netherite'));
        assert.ok(getItemPool(custom, 'sword').includes('Efficiency'));
    });

    it('removing a conflict rule changes compiled conflict bitsets', () => {
        const vanilla = RegistryFactory.build('1.21.11');
        const custom = RegistryFactory.buildWithMutations('1.21.11', {
            type: 'removeConflictRule',
            selector: { enchants: ['Smite', 'Sharpness'], valid_from: '1.0' }
        });

        const sharpness = getEnchantId(vanilla, 'Sharpness');
        const smite = getEnchantId(vanilla, 'Smite');

        assert.strictEqual(hasConflict(vanilla, sharpness, smite), true);
        assert.strictEqual(hasConflict(custom, sharpness, smite), false);
    });

    it('throws when a remove mutation matches no rules', () => {
        assert.throws(
            () => RegistryFactory.buildWithMutations('1.21.11', {
                type: 'removeMaterialRule',
                selector: { material: 'not_real', valid_from: '1.0' }
            }),
            /expected exactly one matching rule; found 0/
        );
    });

    it('throws when a remove mutation matches multiple rules', () => {
        const duplicateWoodRule = { material: 'wood', valid_from: '1.0' };

        assert.throws(
            () => RegistryFactory.buildWithMutations('1.21.11', [
                { type: 'addMaterialRule', rule: duplicateWoodRule },
                { type: 'removeMaterialRule', selector: duplicateWoodRule }
            ]),
            /expected exactly one matching rule; found 2/
        );
    });

    it('should return a valid engine instance', () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        assert.ok(engine, 'Engine should be created');
        assert.strictEqual(engine.registry.version, '1.21.11');
    });

    it('should cache and reuse engine instances for the same version', () => {
        // Clear caches to ensure we start fresh
        EngineFactory.clearCaches();

        const e1 = EngineFactory.createForVersion('1.21.11');
        const e2 = EngineFactory.createForVersion('1.21.11');

        assert.strictEqual(e1, e2, 'Should return the same instance for the same version');
    });

    it('should not use the vanilla version cache when overrides are supplied', () => {
        EngineFactory.clearCaches();

        const cached = EngineFactory.createForVersion('1.21.11');
        const overrideEngine = EngineFactory.createForVersion('1.21.11', {
            cache: new CacheManager({ comboOtherSize: 10, comboBookSize: 10, statsSize: 10, poolSize: 10 })
        });
        const cachedAgain = EngineFactory.createForVersion('1.21.11');

        assert.notStrictEqual(overrideEngine, cached, 'Override engines should be separate instances');
        assert.strictEqual(cachedAgain, cached, 'Override engines should not replace the cached vanilla instance');
    });

    it('should create an engine around exactly the provided registry', () => {
        const registry = RegistryFactory.build('1.0');
        const engine = EngineFactory.create(registry);

        assert.strictEqual(engine.registry, registry);
        assert.strictEqual(engine.registry.version, '1.0');
    });

    it('should return different instances for different versions', () => {
        const e1 = EngineFactory.createForVersion('1.21.11');
        const e2 = EngineFactory.createForVersion('1.0');

        assert.notStrictEqual(e1, e2, 'Should return different instances for different versions');
        assert.strictEqual(e1.registry.version, '1.21.11');
        assert.strictEqual(e2.registry.version, '1.0');
    });

    it('should clear caches when requested', () => {
        const e1 = EngineFactory.createForVersion('1.21.11');
        EngineFactory.clearCaches();
        const e2 = EngineFactory.createForVersion('1.21.11');

        assert.notStrictEqual(e1, e2, 'Should return a new instance after clearCaches()');
    });
});
