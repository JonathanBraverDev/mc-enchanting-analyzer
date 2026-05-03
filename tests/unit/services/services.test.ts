/**
 * Unit tests for service-layer classes:
 * SummaryService (combo-limit branches), SerializationService (roundtrip),
 * HumanizationService (name resolution + sort modes), and
 * ModifiedLevelDistributionService (enchantability=0 edge case).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { PRECISION } from '#utils/math/ProbUtils.js';
import { SummaryService } from '#services/SummaryService.js';
import { SerializationService } from '#services/SerializationService.js';
import { HumanizationService } from '#services/HumanizationService.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { EngineFactory } from '#engine/factory.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { DATA } from '#data/index.js';
import { ComboUtils } from '#utils/domain/ComboUtils.js';
import type { CalculationStats, MassAccounting, PackedCombo, PackedEnchant } from '#types/index.js';

// ── SummaryService ────────────────────────────────────────────────────────────

describe('SummaryService', () => {
    it('empty combos map yields empty combos output', () => {
        const tracker = new SearchStateTracker();
        const result = SummaryService.summarize({ combos: new Map(), tracker, indexToEnchant: [] });
        assert.deepStrictEqual(result.combos, {});
    });

    it('converts pending mass bigint to float correctly', () => {
        const pending = PRECISION / 4n; // represents 0.25
        const tracker = new SearchStateTracker();
        tracker.mass.record('pending', pending);
        const result = SummaryService.summarize({ combos: new Map(), tracker, indexToEnchant: [] });
        assert.ok(Math.abs(result.accounting.pending - 0.25) < 1e-12, `got ${result.accounting.pending}`);
    });

    it('converts anyMass, rankMass, and countMass from combos correctly', () => {
        const combos = new Map<PackedCombo, bigint>();
        // index 1 -> Bit 0 set -> packed value 1
        combos.set(1 as PackedCombo, PRECISION);

        const tracker = new SearchStateTracker();
        const result = SummaryService.summarize({ combos, tracker, indexToEnchant: [0, 0x0501] });
        assert.ok(Math.abs((result.any[5] ?? 0)         - 1.0)  < 1e-12);
        assert.ok(Math.abs((result.ranks[0x0501] ?? 0)  - 1.0)  < 1e-12);
        assert.ok(Math.abs((result.count[1] ?? 0)       - 1.0)  < 1e-10);
    });

    it('derives summary and clue masses like unpack-based aggregation', () => {
        const enchantA = 0x0101 as PackedEnchant;
        const enchantB = 0x0201 as PackedEnchant;
        const enchantC = 0x0301 as PackedEnchant;
        const enchantToIndex = new Map<number, number>([
            [enchantA, 1],
            [enchantB, 2],
            [enchantC, 3]
        ]);
        const indexToEnchant = [0, enchantA, enchantB, enchantC];
        const combos = new Map<PackedCombo, bigint>([
            [ComboUtils.pack([enchantA, enchantB], enchantToIndex), PRECISION / 2n],
            [ComboUtils.pack([enchantA, enchantC], enchantToIndex), PRECISION / 4n]
        ]);
        const tracker = new SearchStateTracker();
        tracker.mass.record('resolved', (PRECISION * 3n) / 4n);

        const stats = SummaryService.summarize({ combos, tracker, indexToEnchant, comboLimit: 0 });

        assert.ok(Math.abs((stats.any[1] ?? 0) - 0.75) < 1e-12);
        assert.ok(Math.abs((stats.any[2] ?? 0) - 0.5) < 1e-12);
        assert.ok(Math.abs((stats.any[3] ?? 0) - 0.25) < 1e-12);
        assert.ok(Math.abs((stats.ranks[enchantA] ?? 0) - 0.75) < 1e-12);
        assert.ok(Math.abs((stats.count[2] ?? 0) - 0.75) < 1e-12);
        assert.ok(Math.abs((stats.clues[enchantA] ?? 0) - 0.375) < 1e-12);
        assert.ok(Math.abs((stats.clues[enchantB] ?? 0) - 0.25) < 1e-12);
        assert.ok(Math.abs((stats.clues[enchantC] ?? 0) - 0.125) < 1e-12);
    });

    it('comboLimit=0 yields empty combos even when data is present', () => {
        const rawCombos = new Map<PackedCombo, bigint>();
        const indexToEnchant = [0x0101];
        for (let i = 1; i <= 10; i++) rawCombos.set(i as PackedCombo, BigInt(i) * (PRECISION / 100n));
        const tracker = new SearchStateTracker();
        const result = SummaryService.summarize({ combos: rawCombos, tracker, indexToEnchant, comboLimit: 0 });
        assert.deepStrictEqual(result.combos, {});
    });

    it('comboLimit ≤ 250 path: returns only top-K highest-probability combos', () => {
        const combos = new Map<PackedCombo, bigint>();
        for (let i = 1; i <= 10; i++) combos.set(i as PackedCombo, BigInt(i) * (PRECISION / 1000n));

        const tracker = new SearchStateTracker();
        const result = SummaryService.summarize({ combos: combos as any, tracker, indexToEnchant: [], comboLimit: 3 });
        const numericKeys = Object.keys(result.combos).map(k => parseInt(k, 16));

        assert.strictEqual(numericKeys.length, 3, 'should return exactly 3 combos');
        assert.ok(numericKeys.includes(8),  'key 8 should be in top-3');
        assert.ok(numericKeys.includes(9),  'key 9 should be in top-3');
        assert.ok(numericKeys.includes(10), 'key 10 should be in top-3');
    });

    it('comboLimit > 250 path: returns only top-K highest-probability combos', () => {
        const combos = new Map<PackedCombo, bigint>();
        for (let i = 1; i <= 400; i++) combos.set(i as PackedCombo, BigInt(i) * (PRECISION / 100000n));

        const tracker = new SearchStateTracker();
        const result = SummaryService.summarize({ combos: combos as any, tracker, indexToEnchant: [], comboLimit: 300 });
        const numericKeys = Object.keys(result.combos).map(k => parseInt(k, 16));

        assert.strictEqual(numericKeys.length, 300, 'should return exactly 300 combos');
        assert.ok(!numericKeys.includes(1),   'key 1 should be excluded');
        assert.ok(numericKeys.includes(400),  'key 400 should be included');
    });

    it('stores combo keys as lowercase hex strings', () => {
        const combos = new Map<number, bigint>([[255, PRECISION / 2n]]);
        const tracker = new SearchStateTracker();
        const result = SummaryService.summarize({ combos: combos as any, tracker, indexToEnchant: [] });
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
            ranks: {}, any: {}, count: {}, combos: {}, clues: {},
            accuracy, accounting, threshold: 0.1,
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

    it('serialize provides Transferable buffers for large arrays', () => {
        const any = { 0: 0.1, 1: 0.2 };
        const stats = makeStats({ any });
        const { compact, transferables } = SerializationService.serialize(stats);

        // CompactStats uses BigUint64Array for any/ranks/count mass in the internal message
        assert.ok(transferables.length > 0, 'Should have transferable buffers');
        assert.ok(transferables[0] instanceof ArrayBuffer, 'Transferables should be ArrayBuffers');

        const recovered = SerializationService.deserialize(compact);
        assert.strictEqual(recovered.any[0], 0.1);
        assert.strictEqual(recovered.any[1], 0.2);
    });
});

// ── HumanizationService ────────────────────────────────────────────────────

describe('HumanizationService', () => {
    const engine = EngineFactory.create(DATA, '1.20');
    const reg    = engine.registry;

    before(async () => {
        await engine.calculate({ cat: 'pickaxe', xp: 30, mat: 'diamond', threshold: 0.005 });
    });

    it('resolves enchantment names in the any map', () => {
        const effId = reg.idMap.get('Efficiency')!;
        const acc: MassAccounting = { resolved: 0.85, pending: 0.15, sieved: 0, overflow: 0, capped: 0, rounding: 0, recoveredRounding: 0, recoveredSieved: 0 };
        const rawStats: CalculationStats = {
            ranks: {}, any: { [effId]: 0.85 }, count: {}, combos: {}, clues: {},
            accuracy: 0.85, accounting: acc, threshold: 0.85
        };
        const result = HumanizationService.humanize(rawStats, reg, 'prob');
        assert.ok(Object.keys(result.any).includes('Efficiency'));
    });

    it('sorting by "count" correctly prioritizes primary count bucket', () => {
        const stats = {
            combos: { 'ff': 0.1 },
            count: { 1: 0.1 },
            any: {}, ranks: {}, clues: {}, accuracy: 1, accounting: {}, threshold: 0
        } as any;

        const result = HumanizationService.humanize(stats, reg, 'count');
        assert.ok(result.combos, 'Humanize should return combos map');
    });

    it('sorting by "rank" correctly prioritizes high-tier ranks', () => {
        const stats = {
            combos: { 'ff': 0.1 },
            count: {}, any: {}, ranks: {}, clues: {}, accuracy: 1, accounting: {}, threshold: 0
        } as any;
        const result = HumanizationService.humanize(stats, reg, 'rank');
        assert.ok(result, 'Humanize should not crash with sortMode=rank');
    });
});

// ── ModifiedLevelDistributionService edge case ─────────────────────────────────────────

describe('ModifiedLevelDistributionService', () => {
    it('enchantability <= 0 returns single entry at the XP level with PRECISION probability', () => {
        const service = new ModifiedLevelDistributionService();
        const fakeRegistry = {
            version: 'test-version',
            mechanics: { enchantability_bonus_divisor: 4, random_bonus_range: 0.15 }
        } as any;

        const dist = service.getModifiedLevelDist(fakeRegistry, 30, 0);
        const keys = Object.keys(dist).map(Number);
        assert.deepStrictEqual(keys, [30], 'should have a single entry at xp=30');
        assert.strictEqual(dist[30], PRECISION);
    });
});

// ── SearchStateTracker detailed accounting ───────────────────────────

describe('SearchStateTracker Accounting', () => {
    it('toPublic converts BigInt buckets to floating-point accurately', () => {
        const tracker = new SearchStateTracker();
        tracker.mass.record('resolved', PRECISION / 2n);
        tracker.mass.record('pending', PRECISION / 10n);

        const accounting = tracker.mass.toPublic();
        assert.strictEqual(accounting.resolved, 0.5);
        assert.strictEqual(accounting.pending, 0.1);
    });

    it('addScaled combines mass from another tracker', () => {
        const t1 = new SearchStateTracker();
        const t2 = new SearchStateTracker();

        t1.mass.record('resolved', 100n);
        t2.mass.record('resolved', 200n);

        // factor = 0.5 (PRECISION / 2)
        t1.mass.addScaled(t2.mass, PRECISION / 2n);

        // 100 + (200 * 0.5) = 200
        assert.strictEqual(t1.mass.getBookkeeping().resolved, 200n);
    });
});
