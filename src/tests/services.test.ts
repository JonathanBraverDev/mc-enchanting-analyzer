/**
 * Unit tests for service-layer classes:
 * SummaryService (combo-limit branches), SerializationService (roundtrip),
 * HumanizationService (name resolution + sort modes), and
 * DistributionService (enchantability=0 edge case).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { PRECISION } from '../utils/math/ProbUtils.js';
import { SummaryService } from '../services/SummaryService.js';
import { SerializationService } from '../services/SerializationService.js';
import { HumanizationService } from '../services/HumanizationService.js';
import { DistributionService } from '../engine/distribution.js';
import { EnchantEngine } from '../engine/index.js';
import { MassAccountant } from '../engine/MassAccountant.js';
import { DATA } from '../data/index.js';
import type { CalculationStats, MassAccounting } from '../types/index.js';

// ── SummaryService ────────────────────────────────────────────────────────────

describe('SummaryService', () => {
    it('empty combos map yields empty combos output', () => {
        const acc = new MassAccountant();
        const result = SummaryService.summarize(new Map(), acc);
        assert.deepStrictEqual(result.combos, {});
    });

    it('converts pending mass bigint to float correctly', () => {
        const pending = PRECISION / 4n; // represents 0.25
        const acc = new MassAccountant();
        acc.record('pending', pending);
        const result = SummaryService.summarize(new Map(), acc);
        assert.ok(Math.abs(result.accounting.pending - 0.25) < 1e-12, `got ${result.accounting.pending}`);
    });

    it('converts anyMass, rankMass, and countMass to float probabilities', () => {
        const anyMass   = new Map([[5, PRECISION / 2n]]);          // id 5 → 0.5
        const rankMass  = new Map([[0x0501, PRECISION / 4n]]);     // idAndRank 0x501 → 0.25
        const countMass = new Map([[3, PRECISION / 5n]]);          // count 3 → 0.2
        const acc = new MassAccountant();
        const result = SummaryService.summarize(new Map(), acc, anyMass, rankMass, countMass);
        assert.ok(Math.abs(result.any[5]         - 0.5)  < 1e-12);
        assert.ok(Math.abs(result.ranks[0x0501]  - 0.25) < 1e-12);
        assert.ok(Math.abs(result.count[3]       - 0.2)  < 1e-10);
    });

    it('comboLimit=0 yields empty combos even when data is present', () => {
        const combos = new Map<number, bigint>();
        for (let i = 1; i <= 10; i++) combos.set(i, BigInt(i) * (PRECISION / 100n));
        const acc = new MassAccountant();
        const result = SummaryService.summarize(combos, acc, undefined, undefined, undefined, 0);
        assert.deepStrictEqual(result.combos, {});
    });

    it('comboLimit ≤ 200 path: returns only top-K highest-probability combos', () => {
        // 10 combos keyed 1..10 with probabilities proportional to key value
        const combos = new Map<number, bigint>();
        for (let i = 1; i <= 10; i++) combos.set(i, BigInt(i) * (PRECISION / 1000n));

        const acc = new MassAccountant();
        const result = SummaryService.summarize(combos, acc, undefined, undefined, undefined, 3);
        const numericKeys = Object.keys(result.combos).map(k => parseInt(k, 16));

        assert.strictEqual(numericKeys.length, 3, 'should return exactly 3 combos');
        // Top-3 by value: keys 8, 9, 10
        assert.ok(numericKeys.includes(8),  'key 8 should be in top-3');
        assert.ok(numericKeys.includes(9),  'key 9 should be in top-3');
        assert.ok(numericKeys.includes(10), 'key 10 should be in top-3');
        assert.ok(!numericKeys.includes(1), 'key 1 (lowest) should be excluded');
    });

    it('comboLimit > 200 path: returns only top-K highest-probability combos', () => {
        // 300 combos keyed 1..300 with probabilities proportional to key value
        const combos = new Map<number, bigint>();
        for (let i = 1; i <= 300; i++) combos.set(i, BigInt(i) * (PRECISION / 100000n));

        const acc = new MassAccountant();
        const result = SummaryService.summarize(combos, acc, undefined, undefined, undefined, 250);
        const numericKeys = Object.keys(result.combos).map(k => parseInt(k, 16));

        assert.strictEqual(numericKeys.length, 250, 'should return exactly 250 combos');
        // Top 250 are keys 51..300; keys 1..50 should be excluded
        assert.ok(!numericKeys.includes(1),   'key 1 should be excluded');
        assert.ok(!numericKeys.includes(50),  'key 50 should be excluded');
        assert.ok(numericKeys.includes(51),   'key 51 should be included');
        assert.ok(numericKeys.includes(300),  'key 300 should be included');
    });

    it('stores combo keys as lowercase hex strings', () => {
        const combos = new Map<number, bigint>([[255, PRECISION / 2n]]);
        const acc = new MassAccountant();
        const result = SummaryService.summarize(combos, acc);
        assert.ok(
            Object.keys(result.combos).includes('ff'),
            'key 255 should be stored as hex "ff"'
        );
    });

    it('when combos.size <= comboLimit all combos are kept', () => {
        const combos = new Map<number, bigint>();
        for (let i = 1; i <= 5; i++) combos.set(i, BigInt(i) * (PRECISION / 100n));
        const acc = new MassAccountant();
        const result = SummaryService.summarize(combos, acc, undefined, undefined, undefined, 10);
        assert.strictEqual(Object.keys(result.combos).length, 5);
    });

    it('output combos are explicitly sorted by probability descending', () => {
        const combos = new Map<number, bigint>();
        // Use keys that contain letters so V8 doesn't reorder them as numeric keys
        combos.set(0xa, PRECISION / 10n); // 0.1
        combos.set(0xb, PRECISION / 2n);  // 0.5
        combos.set(0xc, PRECISION / 4n);  // 0.25
        
        const acc = new MassAccountant();
        const result = SummaryService.summarize(combos, acc, undefined, undefined, undefined, 10);
        const probs = Object.values(result.combos);
        
        // Expected order: 0.5 (b), 0.25 (c), 0.1 (a)
        assert.strictEqual(probs[0], 0.5,  'highest prob should be first');
        assert.strictEqual(probs[1], 0.25, 'middle prob should be second');
        assert.strictEqual(probs[2], 0.1,  'lowest prob should be last');
    });
});

// ── SerializationService ───────────────────────────────────────────────────

describe('SerializationService', () => {
    const makeStats = (overrides: Partial<CalculationStats> = {}): CalculationStats => {
        const accuracy = overrides.accuracy ?? 1.0;
        const accounting = overrides.accounting ?? { 
            resolved: accuracy, pending: 0, sieved: 0, overflow: 0, 
            capped: 0, rounding: 0, recoveredRounding: 0, recoveredSieved: 0 
        };
        return {
            ranks: {}, any: {}, count: {}, combos: {}, 
            accuracy, accounting,
            ...overrides
        };
    };

    it('roundtrip preserves accuracy and accounting fields', () => {
        const acc: MassAccounting = { resolved: 0.5, pending: 0.1, sieved: 0.2, overflow: 0.1, capped: 0, rounding: 0.1 };
        const stats = makeStats({ accuracy: 0.5, accounting: acc });
        const { compact } = SerializationService.serialize(stats);
        const recovered = SerializationService.deserialize(compact);
        assert.strictEqual(recovered.accuracy, 0.5);
        assert.deepStrictEqual(recovered.accounting, acc);
    });

    it('roundtrip preserves combo entries (hex keys)', () => {
        const { compact } = SerializationService.serialize(makeStats({
            combos: { 'ff': 0.5, '1a2b': 0.3 }
        }));
        const recovered = SerializationService.deserialize(compact);
        assert.ok(Math.abs((recovered.combos['ff']   as number) - 0.5) < 1e-10);
        assert.ok(Math.abs((recovered.combos['1a2b'] as number) - 0.3) < 1e-10);
    });

    it('roundtrip preserves rank entries', () => {
        const { compact } = SerializationService.serialize(makeStats({
            ranks: { 256: 0.7, 512: 0.2 }
        }));
        const recovered = SerializationService.deserialize(compact);
        assert.ok(Math.abs((recovered.ranks[256] as number) - 0.7) < 1e-10);
        assert.ok(Math.abs((recovered.ranks[512] as number) - 0.2) < 1e-10);
    });

    it('roundtrip preserves any entries', () => {
        const { compact } = SerializationService.serialize(makeStats({
            any: { 3: 0.9, 7: 0.4 }
        }));
        const recovered = SerializationService.deserialize(compact);
        assert.ok(Math.abs((recovered.any[3] as number) - 0.9) < 1e-10);
        assert.ok(Math.abs((recovered.any[7] as number) - 0.4) < 1e-10);
    });

    it('roundtrip preserves non-zero count entries and omits zero entries', () => {
        const { compact } = SerializationService.serialize(makeStats({
            count: { 2: 0.5, 3: 0.3 }
        }));
        const recovered = SerializationService.deserialize(compact);
        assert.ok(Math.abs((recovered.count[2] as number) - 0.5) < 1e-10);
        assert.ok(Math.abs((recovered.count[3] as number) - 0.3) < 1e-10);
        // Entry 0 was never set; should remain absent
        assert.strictEqual(recovered.count[0], undefined);
    });

    it('serialize returns an array of ArrayBuffer transferables', () => {
        const { transferables } = SerializationService.serialize(makeStats());
        assert.ok(Array.isArray(transferables));
        assert.ok(transferables.length > 0);
        assert.ok(transferables.every(t => t instanceof ArrayBuffer));
    });

    it('empty stats roundtrip produces empty collections', () => {
        const { compact } = SerializationService.serialize(makeStats());
        const recovered = SerializationService.deserialize(compact);
        assert.deepStrictEqual(recovered.ranks, {});
        assert.deepStrictEqual(recovered.any,   {});
        assert.deepStrictEqual(recovered.combos, {});
        // count may have entries for indices where counts[i] > 0 — none here
        assert.strictEqual(Object.values(recovered.count).filter(v => v > 0).length, 0);
    });
});

// ── HumanizationService ────────────────────────────────────────────────────

describe('HumanizationService', () => {
    // Use a real engine so ComboUtils is initialized with production enchant data.
    const engine = new EnchantEngine(DATA, '1.20');
    const reg    = engine.registry;

    let stats: CalculationStats;
    before(async () => {
        // Coarse run — fast enough for a unit test, produces multiple combos
        stats = await engine.getFullStats('pickaxe', 30, 'diamond', { threshold: 0.005 });
    });

    it('resolves enchantment names in the any map', () => {
        const effId = reg.idMap.get('Efficiency')!;
        const acc: MassAccounting = { resolved: 0.85, pending: 0.15, sieved: 0, overflow: 0, capped: 0, rounding: 0 };
        const rawStats: CalculationStats = {
            ranks: {}, any: { [effId]: 0.85 }, count: {}, combos: {}, 
            accuracy: 0.85, accounting: acc
        };
        const result = HumanizationService.humanize(rawStats, reg, 'prob');
        assert.ok(Object.keys(result.any).includes('Efficiency'), 'Efficiency should appear by name');
        assert.ok(Math.abs((result.any['Efficiency'] as number) - 0.85) < 1e-10);
    });

    it('resolves full enchantment names (with rank) in the ranks map', () => {
        const effId   = reg.idMap.get('Efficiency')!;
        const idRank4 = (effId << 8) | 4; // Efficiency IV
        const acc: MassAccounting = { resolved: 0.6, pending: 0.4, sieved: 0, overflow: 0, capped: 0, rounding: 0 };
        const rawStats: CalculationStats = {
            ranks: { [idRank4]: 0.6 }, any: {}, count: {}, combos: {},
            accuracy: 0.6, accounting: acc
        };
        const result = HumanizationService.humanize(rawStats, reg, 'prob');
        assert.ok(Object.keys(result.ranks).includes('Efficiency IV'), 'Efficiency IV should appear');
        assert.ok(Math.abs((result.ranks['Efficiency IV'] as number) - 0.6) < 1e-10);
    });

    it('passes through count, accuracy, and accounting data unchanged', () => {
        const acc: MassAccounting = { resolved: 0.9, pending: 0.05, sieved: 0.05, overflow: 0, capped: 0, rounding: 0 };
        const rawStats: CalculationStats = {
            ranks: {}, any: {}, count: { 1: 0.6, 2: 0.3 }, combos: {},
            accuracy: 0.9, accounting: acc
        };
        const result = HumanizationService.humanize(rawStats, reg, 'prob');
        assert.ok(Math.abs((result.count[1] as number) - 0.6) < 1e-10);
        assert.ok(Math.abs((result.count[2] as number) - 0.3) < 1e-10);
        assert.strictEqual(result.accuracy, 0.9);
        assert.strictEqual(result.accounting.pending, 0.05);
        assert.deepStrictEqual(result.accounting, acc);
    });

    it('combo keys use "+" to separate enchantment names', () => {
        const result = HumanizationService.humanize(stats, reg, 'prob');
        const multiEnchant = Object.keys(result.combos).filter(k => k.includes('+'));
        // Pickaxe at level 30 diamond should produce multi-enchant results
        assert.ok(multiEnchant.length > 0, 'should have multi-enchant combos with "+" separator');
    });

    it('sort by prob: combos are in non-increasing probability order', () => {
        const result = HumanizationService.humanize(stats, reg, 'prob');
        const probs = Object.values(result.combos) as number[];
        for (let i = 1; i < probs.length; i++) {
            assert.ok(
                probs[i - 1] >= probs[i],
                `prob at index ${i - 1} (${probs[i-1]}) should be >= index ${i} (${probs[i]})`
            );
        }
    });

    it('sort by count: primary sort is by enchant count descending', () => {
        const result = HumanizationService.humanize(stats, reg, 'count');
        const counts = Object.keys(result.combos).map(k => k.split('+').length);
        // Primary sort: count descending (ties broken by prob, so not strictly equal)
        // Verify first entry has count >= last entry (weakest invariant guaranteed by the sort)
        if (counts.length > 1) {
            assert.ok(counts[0] >= counts[counts.length - 1],
                'first entry should have count >= last entry');
        }
    });

    it('sort by rank: primary sort is by total rank sum descending', () => {
        const romanMap = reg.data.constants.ROMAN_MAP;
        const result = HumanizationService.humanize(stats, reg, 'rank', romanMap);
        // First entry should have rank sum >= last entry
        const getRankSum = (key: string) => key.split('+').reduce((sum, e) => {
            const last = e.trim().split(' ').pop() || '';
            return sum + (romanMap[last as keyof typeof romanMap] || 0);
        }, 0);
        const keys = Object.keys(result.combos);
        if (keys.length > 1) {
            const firstSum = getRankSum(keys[0]);
            const lastSum  = getRankSum(keys[keys.length - 1]);
            assert.ok(firstSum >= lastSum,
                `first rank sum ${firstSum} should be >= last ${lastSum}`);
        }
    });
});

// ── DistributionService edge case ─────────────────────────────────────────

describe('DistributionService', () => {
    it('enchantability <= 0 returns single entry at the XP level with PRECISION probability', () => {
        // The guard "if (enchantability <= 0) return { [xp]: PRECISION }" must fire
        const fakeRegistry = {
            mechanics: { enchantability_bonus_divisor: 4, random_bonus_range: 0.15 }
        } as any;

        const dist = DistributionService.getModifiedLevelDist(30, 0, fakeRegistry);
        const keys = Object.keys(dist).map(Number);
        assert.deepStrictEqual(keys, [30], 'should have a single entry at xp=30');
        assert.strictEqual(dist[30], PRECISION, 'the single entry should equal PRECISION (1.0)');
    });

    it('result is cached: same call returns the identical object reference', () => {
        const fakeRegistry = {
            mechanics: { enchantability_bonus_divisor: 4, random_bonus_range: 0.15 }
        } as any;
        const cache = new Map<string, Record<number, bigint>>();

        const first  = DistributionService.getModifiedLevelDist(30, 10, fakeRegistry, cache);
        const second = DistributionService.getModifiedLevelDist(30, 10, fakeRegistry, cache);
        assert.strictEqual(first, second, 'cached call should return the exact same object');
    });
});
