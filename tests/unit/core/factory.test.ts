import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isItemAvailable } from '#core/registry.js';
import { RegistryFactory } from '#core/factory.js';
import { EngineFactory } from '#engine/factory.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { DATA } from '#data/index.js';
import type { EnchantmentData } from '#types/index.js';

function cloneData(): EnchantmentData {
    return JSON.parse(JSON.stringify(DATA)) as EnchantmentData;
}

describe('EngineFactory', () => {
    it('builds the bundled vanilla registry by version', () => {
        const registry = RegistryFactory.build('1.21.11');

        assert.strictEqual(registry.version, '1.21.11');
        assert.ok(isItemAvailable(registry, 'book'));
    });

    it('builds custom registry data through the explicit custom-data path', () => {
        const customData = cloneData();
        customData.enchantable_item_rules = customData.enchantable_item_rules.filter(rule => rule.item !== 'mace');

        const vanilla = RegistryFactory.build('1.21.11');
        const custom = RegistryFactory.buildFromData(customData, '1.21.11');

        assert.strictEqual(isItemAvailable(vanilla, 'mace'), true);
        assert.strictEqual(isItemAvailable(custom, 'mace'), false);
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
