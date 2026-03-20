import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from './engine.js';
import { DATA } from './data.js';
import { ResultProcessor } from './utils.js';
import { PRECISION, ProbUtils, ComboUtils } from './utils.js';
import { SnapshotUtils } from './test-utils.js';

// Polyfill for requestAnimationFrame in Node (Sync version for tests)
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: Function) => callback(Date.now());
}

describe('Enchantment Engine Test Suite', () => {
    test.afterEach(() => {
        EnchantEngine.clearAllCaches();
    });

    describe('1. Core Engine Logic', () => {
        const engine = new EnchantEngine(DATA, '1.21');

        it('should maintain total probability of Modified Level Distribution near 1.0 (Exact BigInt)', () => {
            const dist = engine.getModifiedLevelDist(30, 10);
            const totalProb = Object.values(dist).reduce((a, b) => a + b, 0n);
            const totalProbNum = ProbUtils.toNumber(totalProb);
            assert.ok(Math.abs(totalProbNum - 1.0) < 0.000001, `Total probability ${totalProbNum} is not close enough to 1.0`);
        });

        it('should NOT return "X undefined" when no enchants are possible', async () => {
            const stats = await engine.getFullStats('sword', 1, 'diamond');
            const hasUndefined = Object.keys(stats.combos).some(c => c.includes('undefined')) ||
                                Object.keys(stats.ranks).some(r => r.includes('undefined'));
            assert.ok(!hasUndefined, '"undefined" should not appear in results');
        });
    });

    describe('2. Version Compatibility & Historical Changes', () => {
        it('1.11.1+: Sweeping Edge should only appear in valid versions', async () => {
            const v18 = new EnchantEngine(DATA, '1.8');
            const id = v18.registry.idMap.get('Sweeping Edge')!;
            const s18 = await v18.getFullStats('sword', 30, 'diamond');
            assert.ok(!s18.any[id]);

            const v111 = new EnchantEngine(DATA, '1.11.1');
            const s111 = await v111.getFullStats('sword', 30, 'diamond');
            assert.ok(s111.any[id] > 0);
        });

        it('1.14 vs 1.14.3: Protection conflict window', async () => {
            const e114 = new EnchantEngine(DATA, '1.14');
            const e1143 = new EnchantEngine(DATA, '1.14.3');
            const protNames = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];
            const getBases = (c: string) => c.split("+").map(e => e.split(" ").slice(0, -1).join(" "));

            const s114 = await e114.getFullStats('chestplate', 30, 'diamond', null, 0.0001);
            const h114 = ResultProcessor.humanize(s114, e114.registry);
            const multi114 = Object.keys(h114.combos).filter(c => {
                return getBases(c).filter(b => protNames.includes(b)).length > 1;
            });
            assert.ok(multi114.length > 0, '1.14 should allow multi-protection');

            const s1143 = await e1143.getFullStats('chestplate', 30, 'diamond', null, 0.0001);
            const h1143 = ResultProcessor.humanize(s1143, e1143.registry);
            const multi1143 = Object.keys(h1143.combos).some(c => {
                return getBases(c).filter(b => protNames.includes(b)).length > 1;
            });
            assert.ok(!multi1143, '1.14.3 should block multi-protection');
        });

        it('1.21+: Mace exclusive enchantments', async () => {
            const v116 = new EnchantEngine(DATA, '1.16');
            assert.ok(!v116.registry.mergedItems['mace']);

            const v121 = new EnchantEngine(DATA, '1.21');
            const id = v121.registry.idMap.get('Density')!;
            const s121 = await v121.getFullStats('mace', 30, 'mace');
            assert.ok(s121.any[id] > 0);
        });
    });

    describe('3. Item Categories & Material Rules', () => {
        const engine = new EnchantEngine(DATA, '1.20');

        it('Books: Availability and multiplicity rules (1.3.1, 1.4.6, 1.7.2)', async () => {
            // 1.3.1: Not eligible
            const reg131 = new EnchantEngine(DATA, '1.3.1').registry;
            assert.ok(!reg131.getEligibleMaterials('book').includes('book'));

            // 1.4.6: Single only
            const v146 = new EnchantEngine(DATA, '1.4.6');
            const s146 = await v146.getFullStats('book', 30, 'book');
            const h146 = ResultProcessor.humanize(s146, v146.registry);
            assert.ok(!Object.keys(h146.combos).some(c => c.split('+').length > 1));

            // 1.7.2: Multi allowed
            const v172 = new EnchantEngine(DATA, '1.7.2');
            const s172 = await v172.getFullStats('book', 30, 'book', null, 0.0001);
            const h172 = ResultProcessor.humanize(s172, v172.registry);
            assert.ok(Object.keys(h172.combos).some(c => c.split('+').length > 1));
        });

        it('Tridents: Riptide/Loyalty/Channeling mutual exclusion', async () => {
            const v113 = new EnchantEngine(DATA, '1.13');
            const stats = await v113.getFullStats('trident', 30, 'trident');
            const human = ResultProcessor.humanize(stats, v113.registry);
            
            for (const combo of Object.keys(human.combos)) {
                if (combo.includes('Riptide')) {
                    assert.ok(!combo.includes('Loyalty') && !combo.includes('Channeling'), 'Riptide should conflict with Loyalty/Channeling');
                }
            }
        });

        it('Materials: Gold quality vs Iron', async () => {
            const iron = await engine.getFullStats('sword', 30, 'iron');
            const gold = await engine.getFullStats('sword', 30, 'gold');
            const score = (s: any) => Object.entries(s.count).reduce((a, [c, p]) => a + Number(c) * (p as number), 0);
            assert.ok(score(gold) > score(iron));
        });

        it('Category Constraints: Fortune should not appear on Swords', async () => {
            const stats = await engine.getFullStats('sword', 30, 'diamond');
            const fortuneId = engine.registry.idMap.get('Fortune')!;
            assert.ok(!stats.any[fortuneId]);
        });
    });

    describe('4. Search Algorithm & Accuracy', () => {
        const engine = new EnchantEngine(DATA, '1.20');

        it('Progressive Refinement Parity: Resumed search should match fresh search', async () => {
            const standard = await engine.getFullStats('book', 30, 'book', null, 0.001);
            engine.comboCache.clear();
            engine.statsCache.clear();
            await engine.getFullStats('book', 30, 'book', null, 0.05); // Coarse
            const resumed = await engine.getFullStats('book', 30, 'book', null, 0.001); // Resume
            
            const keysS = Object.keys(standard.any).sort().slice(0, 5);
            const keysR = Object.keys(resumed.any).sort().slice(0, 5);
            assert.deepStrictEqual(keysS, keysR);
        });

        it('Delayed Level Decay & Pool Persistence', async () => {
            const stats = await engine.getFullStats('pickaxe', 30, 'diamond', null, 0.0001);
            const human = ResultProcessor.humanize(stats, engine.registry);
            
            const hasEffIVDeep = Object.keys(human.combos)
                .filter(c => c.split("+").length >= 3)
                .some(c => c.includes("Efficiency IV"));
            assert.ok(hasEffIVDeep);

            assert.ok(human.count[2] > 0.1, "Double enchants should be significant");
            assert.ok((human.count[1] || 0) + (human.count[2] || 0) + (human.count[3] || 0) > 0.9);
        });

        it('God Pick verification (Efficiency IV + Fortune III + Unbreaking III)', async () => {
            const stats = await engine.getFullStats('pickaxe', 30, 'diamond', null, 0.0001);
            const human = ResultProcessor.humanize(stats, engine.registry);
            const targets = ["Efficiency IV", "Fortune III", "Unbreaking III"];
            let prob = 0;
            for (const [combo, pVal] of Object.entries(human.combos)) {
                if (targets.every(t => (combo as string).includes(t))) prob += (pVal as number);
            }
            assert.ok(prob > 0.0001);
        });

        it('Guaranteed First should yield 100% total probability', async () => {
            const guaranteedFirst = "Efficiency IV";
            const stats = await engine.getFullStats('pickaxe', 30, 'diamond', guaranteedFirst, 0.0001);
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
            const stats = await engine.getFullStats('pickaxe', 30, 'diamond', null, 0.00001);
            let totalProb = stats.uncertainty;
            for (const p of Object.values(stats.combos)) {
                totalProb += Number(p);
            }
            assert.ok(Math.abs(totalProb - 1.0) < 1e-12);
        });
    });

    describe('5. Regression Snapshots (Golden Results)', () => {

        it('Snapshot: 1.8 Diamond Sword @ Level 30', async () => {
            const engine = new EnchantEngine(DATA, '1.8');
            const stats = await engine.getFullStats('sword', 30, 'diamond', null, 0.0001);
            await SnapshotUtils.assertSnapshot('1.8_sword_30_diamond', stats);
        });

        it('Snapshot: 1.21 Mace @ Level 30', async () => {
            const engine = new EnchantEngine(DATA, '1.21');
            const stats = await engine.getFullStats('mace', 30, 'mace', null, 0.0001);
            await SnapshotUtils.assertSnapshot('1.21_mace_30_mace', stats);
        });

        it('Snapshot: 1.7.2 Multi-Enchant Book @ Level 30', async () => {
            const engine = new EnchantEngine(DATA, '1.7.2');
            const stats = await engine.getFullStats('book', 30, 'book', null, 0.0001);
            await SnapshotUtils.assertSnapshot('1.7.2_book_30_book', stats);
        });
    });
});

