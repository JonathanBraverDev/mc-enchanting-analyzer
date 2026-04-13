import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine, EnchantEngine } from '../../../src/lib/engine/index.js'; import { EngineFactory } from '../../../src/lib/engine/factory.js';
import { DATA } from '../../../src/lib/data/index.js';
import { ProbUtils } from '../../../src/lib/utils/index.js';
import { HumanizationService } from '../../../src/lib/services/index.js';
import { SnapshotUtils, EngineTestUtils } from '../../infra/test-utils.js';
import { ENGINE_DEFAULTS } from '../../../src/lib/core/config.js';
import { getEnchantId } from '../../../src/lib/core/registry.js';
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
            const stats = await engine.getFullStats(TEST_DATA.ITEMS.SWORD, 1, TEST_DATA.MATERIALS.DIAMOND);
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
            const s18 = await v18.getFullStats(TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND);
            assert.ok(!s18.any[id]);

            const v111 = EngineFactory.create(DATA, '1.11.1');
            const s111 = await v111.getFullStats(TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND);
            assert.ok(s111.any[id] > 0);
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
            const standard = await engine.getFullStats(TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, { threshold: 0.001 });
            engine.resetCaches();
            await engine.getFullStats(TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, { threshold: 0.05 }); // Coarse
            const resumed = await engine.getFullStats(TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, { threshold: 0.001 }); // Resume
            
            const keysS = Object.keys(standard.any).sort().slice(0, 5);
            const keysR = Object.keys(resumed.any).sort().slice(0, 5);
            assert.deepStrictEqual(keysS, keysR);
        });

        it('Delayed Level Decay & Pool Persistence', async () => {
            const stats = await engine.getFullStats(TEST_DATA.ITEMS.PICKAXE, 30, TEST_DATA.MATERIALS.DIAMOND);
            const human = HumanizationService.humanize(stats, engine.registry);
            
            const hasEffIVDeep = Object.keys(human.combos)
                .filter(c => c.split("+").length >= 3)
                .some(c => c.includes("Efficiency IV"));
            assert.ok(hasEffIVDeep);

            assert.ok(human.count[2] > 0.1, "Double enchants should be significant");
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

        it('Guaranteed First should yield 100% total probability', async () => {
            const guaranteedFirst = "Efficiency IV";
            const stats = await engine.getFullStats(TEST_DATA.ITEMS.PICKAXE, 30, TEST_DATA.MATERIALS.DIAMOND, { guaranteedFirst, threshold: TEST_DATA.THRESHOLDS.PROB_MIN });
            const effId = engine.registry.idMap.get('Efficiency')!;
            const probAnyEff = stats.any[effId];
            
            let totalComboProb = 0;
            for (const p of Object.values(stats.combos)) {
                totalComboProb += Number(p);
            }
            assert.ok(probAnyEff > 0.999);
            assert.ok(totalComboProb > 0.999);
        });

        it('should maintain high precision for complex enchantment results', async () => {
            const stats = await engine.getFullStats(TEST_DATA.ITEMS.PICKAXE, 30, TEST_DATA.MATERIALS.DIAMOND, { threshold: 0.00001 });
            let totalProb = 0; // Uncertainty is now properly tracked within the combos themselves as partial states
            for (const p of Object.values(stats.combos)) {
                totalProb += Number(p);
            }
            assert.ok(Math.abs(totalProb - 1.0) < 1e-12);
        });

        it('Frontier Mass Tracking: Guaranteed enchantment must be 100% even with high uncertainty', async () => {
             const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
             
             // Force a high-uncertainty search by setting extremely low maxIterations (e.g., 5)
             const stats = await engine.getFullStats(
                 TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND,
                 { guaranteedFirst: 'Sharpness IV', threshold: 0.000001, maxIterations: 5 }
             );
     
             const sharpnessId = getEnchantId(engine.registry,'Sharpness');
             const anySharpness = stats.any[sharpnessId];
             
             assert.ok(stats.accounting.pending > 0.1, `Expected high uncertainty, got ${stats.accounting.pending}`);
             assert.ok(Math.abs(anySharpness - 1.0) < 0.0001, `Guaranteed enchantment should be ~100%, got ${anySharpness}`);
             
             const totalCounted = Object.values(stats.count).reduce((a: any, b: any) => a + b, 0) as number;
             assert.ok(Math.abs(totalCounted + stats.accounting.pending - 1.0) < 0.0001, 'Total probability including uncertainty must be 1.0');
         });

         it('Regression: Guaranteed first must still allow single-enchant outcomes (Match Wiki)', async () => {
             const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.LAPIS_PIVOT);
             const stats = await engine.getFullStats(TEST_DATA.ITEMS.BOW, 30, TEST_DATA.MATERIALS.BOW, { 
                 guaranteedFirst: 'Power IV', 
                 threshold: 0.0001 
             });
             
             const count1 = stats.count[1] || 0;
             assert.ok(count1 > 0.2, `Expected single-enchant probability to be > 20%, got ${count1}`);
         });

         it('Guaranteed book enchant should be exactly 100%', async () => {
             const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.POST_NETHERITE);
             const stats = await engine.getFullStats(TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, { guaranteedFirst: 'Silk Touch I', threshold: TEST_DATA.THRESHOLDS.PROB_MIN, summaryLimit: 1000 });
             const silkTouchId = getEnchantId(engine.registry,'Silk Touch');
             assert.strictEqual(stats.any[silkTouchId], 1.0, 'Guaranteed book enchant should be 100%');
         });
    });

    describe('5. Regression Snapshots (Golden Results)', () => {
        const SNAPSHOT_LIMIT = ENGINE_DEFAULTS.MAX_RESULTS_UNBOUNDED;
        const SNAPSHOT_ITERATIONS = ENGINE_DEFAULTS.MAX_ITERATIONS_UNBOUNDED;
        const SNAPSHOT_THRESHOLD = 0.00000001;

        it('Snapshot: 1.8 Diamond Sword @ Level 30', async () => {
            const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.LAPIS_PIVOT);
            const stats = await engine.getFullStats(TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND, { threshold: SNAPSHOT_THRESHOLD, maxIterations: SNAPSHOT_ITERATIONS, summaryLimit: SNAPSHOT_LIMIT, resultsLimit: SNAPSHOT_LIMIT, useCache: false });
            await SnapshotUtils.assertSnapshot('1.8_sword_30_diamond', stats);
        });

        it('Snapshot: 1.21 Mace @ Level 30', async () => {
            const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
            const stats = await engine.getFullStats(TEST_DATA.ITEMS.MACE, 30, TEST_DATA.MATERIALS.MACE, { threshold: SNAPSHOT_THRESHOLD, maxIterations: SNAPSHOT_ITERATIONS, summaryLimit: SNAPSHOT_LIMIT, resultsLimit: SNAPSHOT_LIMIT, useCache: false });
            await SnapshotUtils.assertSnapshot('1.21_mace_30_mace', stats);
        });

        it('Snapshot: 1.7.2 Multi-Enchant Book @ Level 30', async () => {
            const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.BOOK_MULTI_LIMIT);
            const stats = await engine.getFullStats(TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, { threshold: SNAPSHOT_THRESHOLD, maxIterations: SNAPSHOT_ITERATIONS, summaryLimit: SNAPSHOT_LIMIT, resultsLimit: SNAPSHOT_LIMIT, useCache: false });
            await SnapshotUtils.assertSnapshot('1.7.2_book_30_book', stats);
        });

        it('Snapshot: 1.21.11 Spear @ Level 30', async () => {
            const engine = EngineFactory.create(DATA, '1.21.11');
            const stats = await engine.getFullStats(TEST_DATA.ITEMS.SPEAR, 30, TEST_DATA.MATERIALS.DIAMOND, { threshold: SNAPSHOT_THRESHOLD, maxIterations: SNAPSHOT_ITERATIONS, summaryLimit: SNAPSHOT_LIMIT, resultsLimit: SNAPSHOT_LIMIT, useCache: false });
            await SnapshotUtils.assertSnapshot('1.21.11_spear_30_diamond', stats);
        });

        it('Snapshot: 1.21.11 Book @ Level 30', async () => {
            const engine = EngineFactory.create(DATA, '1.21.11');
            const stats = await engine.getFullStats(TEST_DATA.ITEMS.BOOK, 30, TEST_DATA.MATERIALS.BOOK, { threshold: SNAPSHOT_THRESHOLD, maxIterations: SNAPSHOT_ITERATIONS, summaryLimit: SNAPSHOT_LIMIT, resultsLimit: SNAPSHOT_LIMIT, useCache: false });
            await SnapshotUtils.assertSnapshot('1.21.11_book_30_book', stats);
        });

        it('Snapshot: 1.21 Diamond Sword @ Level 30 (Guaranteed Sharpness IV)', async () => {
            const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
            const stats = await engine.getFullStats(TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND, { threshold: SNAPSHOT_THRESHOLD, maxIterations: SNAPSHOT_LIMIT, summaryLimit: SNAPSHOT_LIMIT, resultsLimit: SNAPSHOT_LIMIT, useCache: false, guaranteedFirst: 'Sharpness IV' });
            await SnapshotUtils.assertSnapshot('1.21_sword_30_diamond_guaranteed_sharpness', stats);
        });

        it('Snapshot: 1.8 Bow @ Level 30 (Guaranteed Power IV)', async () => {
            const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.LAPIS_PIVOT);
            const stats = await engine.getFullStats(TEST_DATA.ITEMS.BOW, 30, TEST_DATA.MATERIALS.BOW, { threshold: SNAPSHOT_THRESHOLD, maxIterations: SNAPSHOT_ITERATIONS, summaryLimit: SNAPSHOT_LIMIT, resultsLimit: SNAPSHOT_LIMIT, useCache: false, guaranteedFirst: 'Power IV' });
            await SnapshotUtils.assertSnapshot('1.8_bow_30_bow_guaranteed_power', stats);
        });
    });

    describe('6. Cache Isolation & Consistency', () => {
        it('should NOT return cached Sword results when asking for Pickaxe (same material)', async () => {
             const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.LAPIS_PIVOT);
             
             // 1. Get stats for Sword
             const swordStats = await engine.getFullStats(TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND, { threshold: 0.001 });
             const sharpnessId = getEnchantId(engine.registry,'Sharpness') as number;
             assert.ok(swordStats.any[sharpnessId] > 0, 'Sword should have Sharpness');
             
             // 2. Get stats for Pickaxe (same version, level, material)
             // This should bypass the sword cache because category ID is different
             const pickaxeStats = await engine.getFullStats(TEST_DATA.ITEMS.PICKAXE, 30, TEST_DATA.MATERIALS.DIAMOND, { threshold: 0.001 });
             const efficiencyId = getEnchantId(engine.registry,'Efficiency') as number;
             
             assert.strictEqual(pickaxeStats.any[sharpnessId] || 0, 0, 'Pickaxe should NOT have Sharpness');
             assert.ok(pickaxeStats.any[efficiencyId] > 0, 'Pickaxe should have Efficiency');
        });
    });
});



