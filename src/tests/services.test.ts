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
import { ProbabilityMassTracker } from '../engine/ProbabilityMassTracker.js';
import { DATA } from '../data/index.js';
import type { CalculationStats, MassAccounting } from '../types/index.js';

// ── SummaryService ────────────────────────────────────────────────────────────

describe('SummaryService', () => {
    it('empty combos map yields empty combos output', () => {
        const tracker = new ProbabilityMassTracker();
        const result = SummaryService.summarize(new Map(), tracker);
        assert.deepStrictEqual(result.combos, {});
    });

    it('converts pending mass bigint to float correctly', () => {
        const pending = PRECISION / 4n; // represents 0.25
        const tracker = new ProbabilityMassTracker();
        tracker.record('pending', pending);
        const result = SummaryService.summarize(new Map(), tracker);
        assert.ok(Math.abs(result.accounting.pending - 0.25) < 1e-12, `got ${result.accounting.pending}`);
    });

    it('converts anyMass, rankMass, and countMass to float probabilities', () => {
        const anyMass   = new BigUint64Array(256);
        anyMass[5] = PRECISION / 2n;

        const rankMass  = new BigUint64Array(16384);
        rankMass[0x0501] = PRECISION / 4n;

        const countMass = new BigUint64Array(16);
        countMass[3] = PRECISION / 5n;

        const tracker = new ProbabilityMassTracker();
        const result = SummaryService.summarize(new Map(), tracker, anyMass, rankMass, countMass);
        assert.ok(Math.abs(result.any[5]         - 0.5)  < 1e-12);
        assert.ok(Math.abs(result.ranks[0x0501]  - 0.25) < 1e-12);
        assert.ok(Math.abs(result.count[3]       - 0.2)  < 1e-10);
    });

    it('comboLimit=0 yields empty combos even when data is present', () => {
        const combos = new Map<number, bigint>();
        for (let i = 1; i <= 10; i++) combos.set(i, BigInt(i) * (PRECISION / 100n));
        const tracker = new ProbabilityMassTracker();
        const result = SummaryService.summarize(combos, tracker, undefined, undefined, undefined, 0);
        assert.deepStrictEqual(result.combos, {});
    });

    it('comboLimit ≤ 250 path: returns only top-K highest-probability combos', () => {
        const combos = new Map<number, bigint>();
        for (let i = 1; i <= 10; i++) combos.set(i, BigInt(i) * (PRECISION / 1000n));

        const tracker = new ProbabilityMassTracker();
        const result = SummaryService.summarize(combos, tracker, undefined, undefined, undefined, 3);
        const numericKeys = Object.keys(result.combos).map(k => parseInt(k, 16));

        assert.strictEqual(numericKeys.length, 3, 'should return exactly 3 combos');
        assert.ok(numericKeys.includes(8),  'key 8 should be in top-3');
        assert.ok(numericKeys.includes(9),  'key 9 should be in top-3');
        assert.ok(numericKeys.includes(10), 'key 10 should be in top-3');
    });

    it('comboLimit > 250 path: returns only top-K highest-probability combos', () => {
        const combos = new Map<number, bigint>();
        for (let i = 1; i <= 400; i++) combos.set(i, BigInt(i) * (PRECISION / 100000n));

        const tracker = new ProbabilityMassTracker();
        const result = SummaryService.summarize(combos, tracker, undefined, undefined, undefined, 300);
        const numericKeys = Object.keys(result.combos).map(k => parseInt(k, 16));

        assert.strictEqual(numericKeys.length, 300, 'should return exactly 300 combos');
        assert.ok(!numericKeys.includes(1),   'key 1 should be excluded');
        assert.ok(numericKeys.includes(400),  'key 400 should be included');
    });

    it('stores combo keys as lowercase hex strings', () => {
        const combos = new Map<number, bigint>([[255, PRECISION / 2n]]);
        const tracker = new ProbabilityMassTracker();
        const result = SummaryService.summarize(combos, tracker);
        assert.ok(Object.keys(result.combos).includes('ff'));
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
        const acc: MassAccounting = { resolved: 0.5, pending: 0.1, sieved: 0.2, overflow: 0.1, capped: 0, rounding: 0.1, recoveredRounding: 0, recoveredSieved: 0 };
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
});

// ── HumanizationService ────────────────────────────────────────────────────

describe('HumanizationService', () => {
    const engine = new EnchantEngine(DATA, '1.20');
    const reg    = engine.registry;

    let stats: CalculationStats;
    before(async () => {
        stats = await engine.getFullStats('pickaxe', 30, 'diamond', { threshold: 0.005 });
    });

    it('resolves enchantment names in the any map', () => {
        const effId = reg.idMap.get('Efficiency')!;
        const acc: MassAccounting = { resolved: 0.85, pending: 0.15, sieved: 0, overflow: 0, capped: 0, rounding: 0, recoveredRounding: 0, recoveredSieved: 0 };
        const rawStats: CalculationStats = {
            ranks: {}, any: { [effId]: 0.85 }, count: {}, combos: {}, 
            accuracy: 0.85, accounting: acc
        };
        const result = HumanizationService.humanize(rawStats, reg, 'prob');
        assert.ok(Object.keys(result.any).includes('Efficiency'));
    });
});

// ── DistributionService edge case ─────────────────────────────────────────

describe('DistributionService', () => {
    it('enchantability <= 0 returns single entry at the XP level with PRECISION probability', () => {
        const fakeRegistry = {
            mechanics: { enchantability_bonus_divisor: 4, random_bonus_range: 0.15 }
        } as any;

        const dist = DistributionService.getModifiedLevelDist('test-version', 30, 0, fakeRegistry);
        const keys = Object.keys(dist).map(Number);
        assert.deepStrictEqual(keys, [30], 'should have a single entry at xp=30');
        assert.strictEqual(dist[30], PRECISION);
    });
});
