import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine, EngineFactory } from '#engine/index.js';
import { DATA } from '#data/index.js';
import { ENGINE_DEFAULTS } from '#core/config.js';

describe('Error Path Tests', () => {
    test.afterEach(() => {
        // No global cache manager
    });

    describe('1. Invalid version strings', () => {
        it('null version throws a clear error', () => {
            assert.throws(
                () => EngineFactory.create(DATA, null as any),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('version'), `Expected "version" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('undefined version throws a clear error', () => {
            assert.throws(
                () => EngineFactory.create(DATA, undefined as any),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('version'), `Expected "version" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('empty string version throws a clear error', () => {
            assert.throws(
                () => EngineFactory.create(DATA, ''),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('version'), `Expected "version" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('"99.99" does not throw during construction', () => {
            // "99.99" resolves to the latest known version for inheritance.
            // Note: enchantment pools will be empty because all enchantments have
            // valid_to defaulting to "99.9", and "99.99" exceeds that range.
            assert.doesNotThrow(() => {
                const engine = EngineFactory.create(DATA, '99.99');
                assert.strictEqual(engine.registry.version, '99.99');
            });
        });
    });

    describe('2. Invalid guaranteedFirst inputs', () => {
        it('completely unknown enchant name throws clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.getFullStats('sword', 30, 'diamond', { guaranteedFirst: 'FakeEnchant X' }),
                (err: Error) => {
                    assert.ok(err.message.includes('Unknown enchantment'), `Expected "Unknown enchantment" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('valid enchant name not applicable to category throws clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            // Aqua Affinity is helmet-only, not applicable to swords
            await assert.rejects(
                () => engine.getFullStats('sword', 30, 'diamond', { guaranteedFirst: 'Aqua Affinity I' }),
                (err: Error) => {
                    assert.ok(err.message.includes('not applicable to category'), `Got: ${err.message}`);
                    return true;
                }
            );
        });

        it('enchant name with wrong roman numeral throws clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            // Sharpness only goes to V, VI is invalid
            await assert.rejects(
                () => engine.getFullStats('sword', 30, 'diamond', { guaranteedFirst: 'Sharpness VI' }),
                (err: Error) => {
                    assert.ok(err.message.includes('Invalid rank'), `Got: ${err.message}`);
                    assert.ok(err.message.includes('exceeds max level of V'), `Got: ${err.message}`);
                    return true;
                }
            );
        });

        it('impossible enchantment for XP level throws clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            // Sharpness V is impossible at level 1
            await assert.rejects(
                () => engine.getFullStats('sword', 1, 'diamond', { guaranteedFirst: 'Sharpness V' }),
                (err: Error) => {
                    assert.ok(err.message.includes('impossible to obtain'), `Got: ${err.message}`);
                    return true;
                }
            );
        });
    });

    describe('3. Unknown category', () => {
        it('unknown category throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.getFullStats('not_a_real_category', 30, 'diamond'),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('category'), `Expected "category" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('empty string category throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.getFullStats('', 30, 'diamond'),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('category'), `Expected "category" in: ${err.message}`);
                    return true;
                }
            );
        });
    });

    describe('4. Unknown material', () => {
        it('unknown material throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.getFullStats('sword', 30, 'unobtanium'),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('material'), `Expected "material" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('empty string material throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.getFullStats('sword', 30, ''),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('material'), `Expected "material" in: ${err.message}`);
                    return true;
                }
            );
        });
    });

    describe('5. Negative or zero XP levels', () => {
        it('XP = 0 throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.getFullStats('sword', 0, 'diamond'),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('XP = -1 throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.getFullStats('sword', -1, 'diamond'),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('XP = -100 throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.getFullStats('sword', -100, 'diamond'),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('NaN XP throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.getFullStats('sword', NaN, 'diamond'),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });
    });

    describe('6. XP level above the version cap', () => {
        it(`XP = ${ENGINE_DEFAULTS.MAX_XP_LEVEL + 1} throws a clear error`, async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.getFullStats('sword', ENGINE_DEFAULTS.MAX_XP_LEVEL + 1, 'diamond'),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('XP = 1000 throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.getFullStats('sword', 1000, 'diamond'),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });

        it(`XP = ${ENGINE_DEFAULTS.MAX_XP_LEVEL} is valid (boundary check)`, async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            const stats = await engine.getFullStats('sword', ENGINE_DEFAULTS.MAX_XP_LEVEL, 'diamond', { threshold: 0.01 });
            assert.ok(Object.keys(stats.any).length > 0, 'Should have enchantment probabilities at max XP');
        });

        it('XP = 1 is valid (minimum boundary check)', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            const stats = await engine.getFullStats('sword', 1, 'diamond', { threshold: 0.01 });
            // At XP=1, modified levels are very low; may produce empty or minimal results - just check no crash
            assert.ok(stats !== null);
        });
    });
});


