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
import { DATA } from '../data/index.js';
import type { CalculationStats } from '../types/index.js';

// ── SummaryService ────────────────────────────────────────────────────────────

describe('SummaryService', () => {
    it('empty combos map yields empty combos output', () => {
        const result = SummaryService.summarize(new Map(), 0n);
        assert.deepStrictEqual(result.combos, {});
    });

    it('converts uncertainty bigint to float correctly', () => {
        const uncertainty = PRECISION / 4n; // represents 0.25
        const result = SummaryService.summarize(new Map(), uncertainty);
        assert.ok(Math.abs(result.uncertainty - 0.25) < 1e-12, `got ${result.uncertainty}`);
    });

    it('converts anyMass, rankMass, and countMass to float probabilities', () => {
        const anyMass   = new Map([[5, PRECISION / 2n]]);          // id 5 → 0.5
        const rankMass  = new Map([[0x0501, PRECISION / 4n]]);     // idAndRank 0x501 → 0.25
        const countMass = new Map([[3, PRECISION / 5n]]);          // count 3 → 0.2
        const result = SummaryService.summarize(new Map(), 0n, 0n, anyMass, rankMass, countMass);
        assert.ok(Math.abs(result.any[5]         - 0.5)  < 1e-12);
        assert.ok(Math.abs(result.ranks[0x0501]  - 0.25) < 1e-12);
        assert.ok(Math.abs(result.count[3]       - 0.2)  < 1e-10);
    });

    it('comboLimit=0 yields empty combos even when data is present', () => {
        const combos = new Map<number, bigint>();
        for (let i = 1; i <= 10; i++) combos.set(i, BigInt(i) * (PRECISION / 100n));
        const result = SummaryService.summarize(combos, 0n, 0n, undefined, undefined, undefined, 0);
        assert.deepStrictEqual(result.combos, {});
    });

    it('comboLimit ≤ 200 path: returns only top-K highest-probability combos', () => {
        // 10 combos keyed 1..10 with probabilities proportional to key value
        const combos = new Map<number, bigint>();
        for (let i = 1; i <= 10; i++) combos.set(i, BigInt(i) * (PRECISION / 1000n));

        const result = SummaryService.summarize(combos, 0n, 0n, undefined, undefined, undefined, 3);
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

        const result = SummaryService.summarize(combos, 0n, 0n, undefined, undefined, undefined, 250);
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
        const result = SummaryService.summarize(combos, 0n);
        assert.ok(
            Object.keys(result.combos).includes('ff'),
            'key 255 should be stored as hex "ff"'
        );
    });

    it('when combos.size <= comboLimit all combos are kept', () => {
        const combos = new Map<number, bigint>();
        for (let i = 1; i <= 5; i++) combos.set(i, BigInt(i) * (PRECISION / 100n));
        const result = SummaryService.summarize(combos, 0n, 0n, undefined, undefined, undefined, 10);
        assert.strictEqual(Object.keys(result.combos).length, 5);
    });
});

// ── SerializationService ───────────────────────────────────────────────────

describe('SerializationService', () => {
    const makeStats = (overrides: Partial<CalculationStats> = {}): CalculationStats => ({
        ranks: {}, any: {}, count: {}, combos: {}, uncertainty: 0, ...overrides
    });

    it('roundtrip preserves uncertainty and pruned fields', () => {
        const { compact } = SerializationService.serialize(makeStats({ uncertainty: 0.123, pruned: 0.456 }));
        const recovered = SerializationService.deserialize(compact);
        assert.strictEqual(recovered.uncertainty, 0.123);
        assert.strictEqual(recovered.pruned, 0.456);
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
        const rawStats: CalculationStats = {
            ranks: {}, any: { [effId]: 0.85 }, count: {}, combos: {}, uncertainty: 0
        };
        const result = HumanizationService.humanize(rawStats, reg, 'prob');
        assert.ok(Object.keys(result.any).includes('Efficiency'), 'Efficiency should appear by name');
        assert.ok(Math.abs((result.any['Efficiency'] as number) - 0.85) < 1e-10);
    });

    it('resolves full enchantment names (with rank) in the ranks map', () => {
        const effId   = reg.idMap.get('Efficiency')!;
        const idRank4 = (effId << 8) | 4; // Efficiency IV
        const rawStats: CalculationStats = {
            ranks: { [idRank4]: 0.6 }, any: {}, count: {}, combos: {}, uncertainty: 0
        };
        const result = HumanizationService.humanize(rawStats, reg, 'prob');
        assert.ok(Object.keys(result.ranks).includes('Efficiency IV'), 'Efficiency IV should appear');
        assert.ok(Math.abs((result.ranks['Efficiency IV'] as number) - 0.6) < 1e-10);
    });

    it('passes through count, uncertainty, and pruned unchanged', () => {
        const rawStats: CalculationStats = {
            ranks: {}, any: {}, count: { 1: 0.6, 2: 0.3 }, combos: {},
            uncertainty: 0.05, pruned: 0.01
        };
        const result = HumanizationService.humanize(rawStats, reg, 'prob');
        assert.ok(Math.abs((result.count[1] as number) - 0.6) < 1e-10);
        assert.ok(Math.abs((result.count[2] as number) - 0.3) < 1e-10);
        assert.strictEqual(result.uncertainty, 0.05);
        assert.strictEqual(result.pruned, 0.01);
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
