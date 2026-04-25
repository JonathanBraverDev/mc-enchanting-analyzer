import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { ProbUtils } from '#utils/index.js';
import { HumanizationService } from '#services/index.js';
import { EngineTestUtils } from '../../infra/test-utils.js';
import { getEnchantId } from '#core/registry.js';
import { TEST_DATA } from '../../infra/test-data.js';

// Polyfill for requestAnimationFrame in Node (Sync version for tests)
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: Function) => callback(Date.now());
}

describe('Enchantment Engine Test Suite', () => {
    describe('1. Core Engine Logic', () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);

        it('should maintain total probability of Modified Level Distribution near 1.0 (Exact BigInt)', () => {
            const dist = engine.getModifiedLevelDist(30, 10);
            const totalProb = Object.values(dist).reduce((a, b) => a + b, 0n);
            const totalProbNum = ProbUtils.toNumber(totalProb);
            assert.ok(Math.abs(totalProbNum - 1.0) < 0.000001, `Total probability ${totalProbNum} is not close enough to 1.0`);
        });

        it('should NOT return "X undefined" when no enchants are possible', async () => {
            const stats = await engine.calculate(TEST_DATA.ITEMS.SWORD, 1, TEST_DATA.MATERIALS.DIAMOND);
            const h = HumanizationService.humanize(stats, engine.registry);
            const hasUndefined = Object.keys(h.combos).some(c => c.includes('undefined')) ||
                                Object.keys(h.ranks).some(r => r.includes('undefined'));
            assert.ok(!hasUndefined, '"undefined" should not appear in results');
        });
    });

    describe('2. Version Compatibility & Search Logic', () => {
        it('1.11.1+: Sweeping Edge should only appear in valid versions', async () => {
            const v18 = EngineFactory.create(DATA, TEST_DATA.VERSIONS.LEGACY);
            const id = v18.registry.idMap.get('Sweeping Edge')!;
            const s18 = await v18.calculate(TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND);
            assert.ok(!(s18.any[id] ?? 0));

            const v111 = EngineFactory.create(DATA, '1.11.1');
            const s111 = await v111.calculate(TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND);
            assert.ok((s111.any[id] ?? 0) > 0);
        });

        it('1.14 vs 1.14.3: Protection conflict window (Engine Check)', async () => {
            const e114 = EngineFactory.create(DATA, TEST_DATA.GOD_ARMOR.START);
            const e1143 = EngineFactory.create(DATA, TEST_DATA.GOD_ARMOR.END);
            const protNames = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];
            const getBases = (c: string) => c.split("+").map(e => e.split(" ").slice(0, -1).join(" "));

            const h114 = await EngineTestUtils.getHumanStats(e114, TEST_DATA.ITEMS.CHESTPLATE, 30, TEST_DATA.MATERIALS.DIAMOND);
            const multi114 = Object.keys(h114.combos).filter(c => {
                return getBases(c).filter(b => protNames.includes(b)).length > 1;
            });
            assert.ok(multi114.length > 0, '1.14 should allow multi-protection');

            const h1143 = await EngineTestUtils.getHumanStats(e1143, TEST_DATA.ITEMS.CHESTPLATE, 30, TEST_DATA.MATERIALS.DIAMOND);
            const multi1143 = Object.keys(h1143.combos).some(c => {
                return getBases(c).filter(b => protNames.includes(b)).length > 1;
            });
            assert.ok(!multi1143, '1.14.3 should block multi-protection');
        });
    });

    describe('4. Search Algorithm & Accuracy', () => {
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.POST_NETHERITE);

        it('Progressive Refinement Parity: Resumed search should match fresh search', async () => {
            const standard = await engine.calculate(TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, { threshold: 0.001 });
            engine.resetCaches();
            await engine.calculate(TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, { threshold: 0.05 }); // Coarse
            const resumed = await engine.calculate(TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, { threshold: 0.001 }); // Resume
            
            const keysS = Object.keys(standard.any).sort().slice(0, 5);
            const keysR = Object.keys(resumed.any).sort().slice(0, 5);
            assert.deepStrictEqual(keysS, keysR);
        });

        it('Delayed Level Decay & Pool Persistence', async () => {
            const stats = await engine.calculate(TEST_DATA.ITEMS.PICKAXE, 30, TEST_DATA.MATERIALS.DIAMOND);
            const human = HumanizationService.humanize(stats, engine.registry);
            
            const hasEffIVDeep = Object.keys(human.combos)
                .filter(c => c.split("+").length >= 3)
                .some(c => c.includes("Efficiency IV"));
            assert.ok(hasEffIVDeep);

            assert.ok((human.count[2] ?? 0) > 0.1, "Double enchants should be significant");
            assert.ok((human.count[1] || 0) + (human.count[2] || 0) + (human.count[3] || 0) + (human.count[4] || 0) > 0.9);
        });

        it('God Pick verification (Efficiency IV + Fortune III + Unbreaking III)', async () => {
            const human = await EngineTestUtils.getHumanStats(engine, TEST_DATA.ITEMS.PICKAXE, 30, TEST_DATA.MATERIALS.DIAMOND);
            const targets = ["Efficiency IV", "Fortune III", "Unbreaking III"];
            let prob = 0;
            for (const [combo, pVal] of Object.entries(human.combos)) {
                if (targets.every(t => (combo as string).includes(t))) prob += (pVal as number);
            }
            assert.ok(prob > 0.0001);
        });

        it('Clue conditioning should yield 100% total probability (Pickaxe)', async () => {
            const clue = "Efficiency IV";
            const stats = await engine.calculate(TEST_DATA.ITEMS.PICKAXE, 30, TEST_DATA.MATERIALS.DIAMOND, { clue, threshold: TEST_DATA.THRESHOLDS.PROB_MIN });
            const effId = engine.registry.idMap.get('Efficiency')!;
            const probAnyEff = stats.any[effId];
            
            let totalComboProb = 0;
            for (const p of Object.values(stats.combos)) {
                totalComboProb += Number(p);
            }
            // Conditioned results should target 1.0 (100% conditional certainty)
            assert.ok((probAnyEff ?? 0) > 0.9999, `Expected ~1.0, got ${probAnyEff}`);
            assert.ok(totalComboProb > 0.9999, `Expected ~1.0, got ${totalComboProb}`);
        });

        it('should maintain high precision for complex enchantment results', async () => {
            const stats = await engine.calculate(TEST_DATA.ITEMS.PICKAXE, 30, TEST_DATA.MATERIALS.DIAMOND, { threshold: 0.00001 });
            let totalProb = 0; // Uncertainty is now properly tracked within the combos themselves as partial states
            for (const p of Object.values(stats.combos)) {
                totalProb += Number(p);
            }
            assert.ok(Math.abs(totalProb - 1.0) < 1e-12);
        });

        it('Frontier Mass Tracking: Clue conditioning must be 100% even with high uncertainty', async () => {
             const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
             
             // Force a high-uncertainty search by setting extremely low maxIterations (e.g., 5)
             const stats = await engine.calculate(
                 TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND,
                 { clue: 'Sharpness IV', threshold: 0.000001, maxIterations: 5 }
             );
     
             const sharpnessId = getEnchantId(engine.registry,'Sharpness');
             const anySharpness = stats.any[sharpnessId];
             
             assert.ok(stats.accounting.pending > 0.1, `Expected high uncertainty, got ${stats.accounting.pending}`);
             assert.ok((anySharpness ?? 0) > 0.9999, 'Any Sharpness prob should be ~1.0 even with high search uncertainty');
             
             // Conditioned results target 1.0 to reflect absolute posterior certainty,
             // while stats.accuracy preserves the search progress.
             const totalComboProb = Object.values(stats.combos).reduce((a: number, b: any) => a + Number(b), 0);
             assert.ok(Math.abs(totalComboProb - 1.0) < 0.0001, 'Conditioned results should sum to 1.0');
         });

         it('Regression: Clue conditioning must still allow single-enchant outcomes (Match Wiki)', async () => {
             const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.LAPIS_PIVOT);
             const stats = await engine.calculate(TEST_DATA.ITEMS.BOW, 30, TEST_DATA.MATERIALS.BOW, { 
                 clue: 'Power IV', 
                 threshold: 0.0001 
             });
             
             const count1 = stats.count[1] || 0;
             assert.ok(count1 > 0.2, `Expected single-enchant probability to be > 20%, got ${count1}`);
         });

         it('Clue conditioned book enchant should be exactly 100%', async () => {
             const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.POST_NETHERITE);
             const stats = await engine.calculate(TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, { clue: 'Silk Touch I', threshold: TEST_DATA.THRESHOLDS.PROB_MIN, summaryLimit: 1000 });
             const silkTouchId = getEnchantId(engine.registry,'Silk Touch');
             assert.strictEqual(stats.any[silkTouchId], 1.0, 'Guaranteed book enchant should be exactly 100%');
         });
    });

    describe('5. Cache Isolation & Consistency', () => {
        it('should NOT return cached Sword results when asking for Pickaxe (same material)', async () => {
             const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.LAPIS_PIVOT);
             
             // 1. Get stats for Sword
             const swordStats = await engine.calculate(TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND, { threshold: 0.001 });
             const sharpnessId = getEnchantId(engine.registry,'Sharpness') as number;
             assert.ok((swordStats.any[sharpnessId] ?? 0) > 0, 'Sword should have Sharpness');
             
             // 2. Get stats for Pickaxe (same version, level, material)
             // This should bypass the sword cache because category ID is different
             const pickaxeStats = await engine.calculate(TEST_DATA.ITEMS.PICKAXE, 30, TEST_DATA.MATERIALS.DIAMOND, { threshold: 0.001 });
             const efficiencyId = getEnchantId(engine.registry,'Efficiency') as number;
             
             assert.strictEqual(pickaxeStats.any[sharpnessId] || 0, 0, 'Pickaxe should NOT have Sharpness');
             assert.ok((pickaxeStats.any[efficiencyId] ?? 0) > 0, 'Pickaxe should have Efficiency');
        });
    });
});



