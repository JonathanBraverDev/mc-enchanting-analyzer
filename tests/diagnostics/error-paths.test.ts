import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { MINECRAFT_RULES } from '#constants/minecraft.js';

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

    describe('2. Invalid clue inputs', () => {
        it('completely unknown clue name throws clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.calculate({ cat: 'sword', xp: 30, mat: 'diamond', clue: 'FakeEnchant X' }),
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
                () => engine.calculate({ cat: 'sword', xp: 30, mat: 'diamond', clue: 'Aqua Affinity I' }),
                (err: Error) => {
                    assert.ok(err.message.includes('not applicable'), `Expected "not applicable" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('enchant name with wrong roman numeral throws clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            // Sharpness only goes to V, VI is invalid
            await assert.rejects(
                () => engine.calculate({ cat: 'sword', xp: 30, mat: 'diamond', clue: 'Sharpness VI' }),
                (err: Error) => {
                    assert.ok(err.message.includes('exceeds max rank'), `Expected "exceeds max rank" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('clue with valid signature but impossible mass does not throw (Bayesian logic)', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            // Sharpness V is impossible at level 1, but Bayesian p(Combo|Clue) just returns zero mass
            const stats = await engine.calculate({ cat: 'sword', xp: 1, mat: 'diamond', clue: 'Sharpness V' });

            // The search itself is still highly accurate/complete (100% of the tiny L1 space explored)
            assert.ok(stats.accuracy > 0.9999, `Expected search to be complete, got accuracy ${stats.accuracy}`);
            // But the results should be empty because the clue is impossible
            assert.strictEqual(Object.keys(stats.combos).length, 0, 'Conditioned results should be empty for impossible clue');
        });
    });

    describe('3. Unknown category', () => {
        it('unknown category throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.calculate({ cat: 'not_a_real_category', xp: 30, mat: 'diamond' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('category'), `Expected "category" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('empty string category throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.calculate({ cat: '', xp: 30, mat: 'diamond' }),
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
                () => engine.calculate({ cat: 'sword', xp: 30, mat: 'unobtanium' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('material'), `Expected "material" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('empty string material throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.calculate({ cat: 'sword', xp: 30, mat: '' }),
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
                () => engine.calculate({ cat: 'sword', xp: 0, mat: 'diamond' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('XP = -1 throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.calculate({ cat: 'sword', xp: -1, mat: 'diamond' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('XP = -100 throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.calculate({ cat: 'sword', xp: -100, mat: 'diamond' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('NaN XP throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.calculate({ cat: 'sword', xp: NaN, mat: 'diamond' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });
    });

    describe('6. XP level above the version cap', () => {
        it(`XP = ${MINECRAFT_RULES.XP_CAP_MODERN + 1} throws a clear error`, async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.calculate({ cat: 'sword', xp: MINECRAFT_RULES.XP_CAP_MODERN + 1, mat: 'diamond' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('XP = 1000 throws a clear error', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            await assert.rejects(
                () => engine.calculate({ cat: 'sword', xp: 1000, mat: 'diamond' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });

        it(`XP = ${MINECRAFT_RULES.XP_CAP_MODERN} is valid (boundary check)`, async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            const stats = await engine.calculate({ cat: 'sword', xp: MINECRAFT_RULES.XP_CAP_MODERN, mat: 'diamond', threshold: 0.01 });
            assert.ok(Object.keys(stats.any).length > 0, 'Should have enchantment probabilities at max XP');
        });

        it(`Legacy: XP = ${MINECRAFT_RULES.XP_CAP_LEGACY} is valid for 1.1`, async () => {
            const engine = EngineFactory.create(DATA, '1.1');
            const stats = await engine.calculate({ cat: 'sword', xp: MINECRAFT_RULES.XP_CAP_LEGACY, mat: 'diamond', threshold: 0.01 });
            assert.ok(Object.keys(stats.any).length > 0, 'Legacy should support XP up to 50');
        });

        it('XP = 1 is valid (minimum boundary check)', async () => {
            const engine = EngineFactory.create(DATA, '1.21');
            const stats = await engine.calculate({ cat: 'sword', xp: 1, mat: 'diamond', threshold: 0.01 });
            // At XP=1, modified levels are very low; may produce empty or minimal results - just check no crash
            assert.ok(stats !== null);
        });
    });
});
