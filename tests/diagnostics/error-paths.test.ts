import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { MINECRAFT_RULES } from '#constants/minecraft.js';

describe('Error Path Tests', () => {
    test.afterEach(() => {
        // No global cache manager
    });

    describe('1. Invalid version strings', () => {
        it('null version throws a clear error', () => {
            assert.throws(
                () => EngineFactory.createForVersion(null as any),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('version'), `Expected "version" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('undefined version throws a clear error', () => {
            assert.throws(
                () => EngineFactory.createForVersion(undefined as any),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('version'), `Expected "version" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('empty string version throws a clear error', () => {
            assert.throws(
                () => EngineFactory.createForVersion(''),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('version'), `Expected "version" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('"99.99" does not throw during construction', () => {
            // "99.99" resolves to the latest known version for inheritance.
            // Availability windows without valid_until remain open-ended, so
            // unknown future versions reuse the latest known registry model.
            assert.doesNotThrow(() => {
                const engine = EngineFactory.createForVersion('99.99');
                assert.strictEqual(engine.registry.version, '99.99');
            });
        });
    });

    describe('2. Invalid clue inputs', () => {
        it('completely unknown clue name throws clear error', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            await assert.rejects(
                () => engine.calculate({ item: 'sword', xp: 30, material: 'diamond', clue: 'FakeEnchant X' }),
                (err: Error) => {
                    assert.ok(err.message.includes('Unknown enchantment'), `Expected "Unknown enchantment" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('valid enchant name not applicable to item throws clear error', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            // Aqua Affinity is helmet-only, not applicable to swords
            await assert.rejects(
                () => engine.calculate({ item: 'sword', xp: 30, material: 'diamond', clue: 'Aqua Affinity I' }),
                (err: Error) => {
                    assert.ok(err.message.includes('not applicable'), `Expected "not applicable" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('enchant name with wrong roman numeral throws clear error', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            // Sharpness only goes to V, VI is invalid
            await assert.rejects(
                () => engine.calculate({ item: 'sword', xp: 30, material: 'diamond', clue: 'Sharpness VI' }),
                (err: Error) => {
                    assert.ok(err.message.includes('exceeds max rank'), `Expected "exceeds max rank" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('clue with valid signature but impossible mass does not throw (Bayesian logic)', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            // Sharpness V is impossible at level 1, but Bayesian p(Combo|Clue) just returns zero mass
            const stats = await engine.calculate({ item: 'sword', xp: 1, material: 'diamond', clue: 'Sharpness V' });

            // The search itself is still highly accurate/complete (100% of the tiny L1 space explored)
            assert.ok(stats.accuracy > 0.9999, `Expected search to be complete, got accuracy ${stats.accuracy}`);
            // But the results should be empty because the clue is impossible
            assert.strictEqual(Object.keys(stats.combos).length, 0, 'Conditioned results should be empty for impossible clue');
        });
    });

    describe('3. Unknown item', () => {
        it('missing item throws a clear error', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            await assert.rejects(
                () => engine.calculate({ xp: 30, material: 'diamond' } as any),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('item'), `Expected "item" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('unknown item throws a clear error', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            await assert.rejects(
                () => engine.calculate({ item: 'not_a_real_item', xp: 30, material: 'diamond' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('item'), `Expected "item" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('empty string item throws a clear error', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            await assert.rejects(
                () => engine.calculate({ item: '', xp: 30, material: 'diamond' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('item'), `Expected "item" in: ${err.message}`);
                    return true;
                }
            );
        });
    });

    describe('4. Unknown material', () => {
        it('missing material throws a clear error', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            await assert.rejects(
                () => engine.calculate({ item: 'sword', xp: 30 } as any),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('material'), `Expected "material" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('unknown material throws a clear error', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            await assert.rejects(
                () => engine.calculate({ item: 'sword', xp: 30, material: 'unobtanium' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('material'), `Expected "material" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('empty string material throws a clear error', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            await assert.rejects(
                () => engine.calculate({ item: 'sword', xp: 30, material: '' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('material'), `Expected "material" in: ${err.message}`);
                    return true;
                }
            );
        });
    });

    describe('5. Negative or zero XP levels', () => {
        it('non-positive XP values throw clear errors', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            for (const xp of [0, -1, -100]) {
                await assert.rejects(
                    () => engine.calculate({ item: 'sword', xp, material: 'diamond' }),
                    (err: Error) => {
                        assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                        return true;
                    },
                    `XP = ${xp} should throw`
                );
            }
        });

        it('NaN XP throws a clear error', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            await assert.rejects(
                () => engine.calculate({ item: 'sword', xp: NaN, material: 'diamond' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });
    });

    describe('6. XP level above the version cap', () => {
        it(`XP = ${MINECRAFT_RULES.XP_CAP_MODERN + 1} throws a clear error`, async () => {
            const engine = EngineFactory.createForVersion('1.21');
            await assert.rejects(
                () => engine.calculate({ item: 'sword', xp: MINECRAFT_RULES.XP_CAP_MODERN + 1, material: 'diamond' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });

        it('XP = 1000 throws a clear error', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            await assert.rejects(
                () => engine.calculate({ item: 'sword', xp: 1000, material: 'diamond' }),
                (err: Error) => {
                    assert.ok(err.message.toLowerCase().includes('xp'), `Expected "xp" in: ${err.message}`);
                    return true;
                }
            );
        });

        it(`XP = ${MINECRAFT_RULES.XP_CAP_MODERN} is valid (boundary check)`, async () => {
            const engine = EngineFactory.createForVersion('1.21');
            const stats = await engine.calculate({ item: 'sword', xp: MINECRAFT_RULES.XP_CAP_MODERN, material: 'diamond', threshold: 0.01 });
            assert.ok(Object.keys(stats.any).length > 0, 'Should have enchantment probabilities at max XP');
        });

        it(`Legacy: XP = ${MINECRAFT_RULES.XP_CAP_LEGACY} is valid for 1.1`, async () => {
            const engine = EngineFactory.createForVersion('1.1');
            const stats = await engine.calculate({ item: 'sword', xp: MINECRAFT_RULES.XP_CAP_LEGACY, material: 'diamond', threshold: 0.01 });
            assert.ok(Object.keys(stats.any).length > 0, 'Legacy should support XP up to 50');
        });

        it('XP = 1 is valid (minimum boundary check)', async () => {
            const engine = EngineFactory.createForVersion('1.21');
            const stats = await engine.calculate({ item: 'sword', xp: 1, material: 'diamond', threshold: 0.01 });
            // At XP=1, modified levels are very low; may produce empty or minimal results - just check no crash
            assert.ok(stats !== null);
        });
    });
});
