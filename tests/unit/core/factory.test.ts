import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine, EngineFactory } from '#engine/index.js';
import { DATA } from '#data/index.js';

describe('EngineFactory', () => {

    it('should return a valid engine instance', () => {
        const engine = EngineFactory.create(DATA, '1.21.11');
        assert.ok(engine, 'Engine should be created');
        assert.strictEqual(engine.registry.version, '1.21.11');
    });

    it('should cache and reuse engine instances for the same version', () => {
        // Clear caches to ensure we start fresh
        EngineFactory.clearCaches();
        
        const e1 = EngineFactory.create(DATA, '1.21.11');
        const e2 = EngineFactory.create(DATA, '1.21.11');
        
        assert.strictEqual(e1, e2, 'Should return the same instance for the same version');
    });

    it('should return different instances for different versions', () => {
        const e1 = EngineFactory.create(DATA, '1.21.11');
        const e2 = EngineFactory.create(DATA, '1.0');
        
        assert.notStrictEqual(e1, e2, 'Should return different instances for different versions');
        assert.strictEqual(e1.registry.version, '1.21.11');
        assert.strictEqual(e2.registry.version, '1.0');
    });

    it('should clear caches when requested', () => {
        const e1 = EngineFactory.create(DATA, '1.21.11');
        EngineFactory.clearCaches();
        const e2 = EngineFactory.create(DATA, '1.21.11');
        
        assert.notStrictEqual(e1, e2, 'Should return a new instance after clearCaches()');
    });
});

