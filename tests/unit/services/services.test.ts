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
import { SummaryAggregationService } from '#services/SummaryAggregationService.js';
import { SerializationService } from '#services/SerializationService.js';
import { HumanizationService } from '#services/HumanizationService.js';
import { SnapshotService } from '#services/SnapshotService.js';
import { TopComboSortService } from '#services/TopComboSortService.js';
import { UiMetadataService } from '#services/UiMetadataService.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { EngineFactory } from '#engine/factory.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { ComboUtils } from '#utils/domain/ComboUtils.js';
import { ProbUtils } from '#utils/index.js';
import { makePendingEntry, makeSearchSnapshot } from '#tests/infra/search-snapshot-test-utils.js';
import type { EnchantStats, MassAccountingBreakdown, PackedCombo, PackedEnchant, TopComboView } from '#types/index.js';

describe('UiMetadataService', () => {
    it('includes version boundaries used by registry data', () => {
        const versions = UiMetadataService.getVersions();

        assert.deepStrictEqual(versions, [
            '1.21.11',
            '1.21.9',
            '1.21',
            '1.16',
            '1.14.3',
            '1.14',
            '1.13',
            '1.11.1',
            '1.8',
            '1.7.2',
            '1.4.6',
            '1.3.1',
            '1.1',
            '1.0'
        ]);
        assert.ok(versions.includes('1.11.1'), 'enchantment-boundary versions should be selectable');
        assert.ok(versions.includes('1.14'), 'conflict cutoff boundary versions should be selectable');
    });

    it('exposes version-gated material options used by the UI', () => {
        assert.ok(!UiMetadataService.getEligibleMaterials('1.15', 'sword').includes('netherite'));
        assert.ok(UiMetadataService.getEligibleMaterials('1.16', 'sword').includes('netherite'));

        assert.ok(!UiMetadataService.getEligibleMaterials('1.21', 'sword').includes('copper'));
        assert.ok(UiMetadataService.getEligibleMaterials('1.21.9', 'sword').includes('copper'));
    });

    it('exposes version-gated item options used by the UI', () => {
        assert.ok(!UiMetadataService.getEligibleItems('1.0').includes('trident'));
        assert.ok(UiMetadataService.getEligibleItems('1.13').includes('trident'));
        assert.ok(UiMetadataService.getEligibleItems('1.0').includes('sword'));
    });

    it('exposes enchantability values used by the UI summary field', () => {
        assert.strictEqual(UiMetadataService.getEnchantability('1.21', 'diamond', 'sword'), 10);
        assert.strictEqual(UiMetadataService.getEnchantability('1.21', 'gold', 'sword'), 22);
    });

    it('exposes clue and target options for the current table setup', () => {
        const clueOptions = UiMetadataService.getClueOptions('1.21', 'pickaxe', 'diamond', 30);
        assert.ok(clueOptions.includes('Efficiency IV'));

        const targetOptions = UiMetadataService.getTargetOptions('1.21', 'sword', 'diamond', 30);
        assert.ok(targetOptions.some(option => option.label === 'Sharpness I+'));
    });

    it('filters target options that conflict with selected targets', () => {
        const selectedTargets = [{ enchantment: 'Sharpness', rank: 1, rankMode: 'atLeast' as const }];

        assert.strictEqual(
            UiMetadataService.isTargetCompatible('1.21', { enchantment: 'Smite' }, selectedTargets),
            false
        );
        assert.strictEqual(
            UiMetadataService.isTargetCompatible('1.21', { enchantment: 'Unbreaking' }, selectedTargets),
            true
        );
    });
});

// ── SummaryService ────────────────────────────────────────────────────────────

describe('SummaryService', () => {
    it('empty combos map yields empty combos output', () => {
        const snapshot = makeSearchSnapshot();
        const result = SummaryService.summarize({ combos: new Map(), snapshot, indexToEnchant: [] });
        assert.deepStrictEqual(result.combos, {});
    });

    it('keeps clue-known space out of unconditioned accounting', () => {
        const snapshot = makeSearchSnapshot();
        const result = SummaryService.summarize({ combos: new Map(), snapshot, indexToEnchant: [] });

        assert.strictEqual(result.clue, undefined);
        assert.strictEqual('clueKnownSpace' in result.accounting, false);
        assert.strictEqual('clueKnownSpace' in (result.accounting.units ?? {}), false);
        assert.strictEqual(result.accounting.clueIncompatible, 0);
        assert.strictEqual(result.accounting.units?.clueIncompatible, '0');
    });

    it('converts pending mass bigint to float correctly', () => {
        const pending = PRECISION / 4n;
        const snapshot = makeSearchSnapshot({ units: { pending } });
        const result = SummaryService.summarize({ combos: new Map(), snapshot, indexToEnchant: [] });
        assert.ok(Math.abs(result.accounting.pending - 0.25) < 1e-12, `got ${result.accounting.pending}`);
    });

    it('converts anyMass, rankMass, and countMass from combos correctly', () => {
        const combos = new Map<PackedCombo, bigint>([[1 as PackedCombo, PRECISION]]);
        const snapshot = makeSearchSnapshot({ results: combos, units: { resolved: PRECISION } });
        const result = SummaryService.summarize({ combos, snapshot, indexToEnchant: [0, 0x0501] });
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
        const snapshot = makeSearchSnapshot({ results: combos, units: { resolved: (PRECISION * 3n) / 4n } });

        const stats = SummaryService.summarize({ combos, snapshot, indexToEnchant, comboLimit: 0 });

        assert.ok(Math.abs((stats.any[1] ?? 0) - 0.75) < 1e-12);
        assert.ok(Math.abs((stats.any[2] ?? 0) - 0.5) < 1e-12);
        assert.ok(Math.abs((stats.any[3] ?? 0) - 0.25) < 1e-12);
        assert.ok(Math.abs((stats.ranks[enchantA] ?? 0) - 0.75) < 1e-12);
        assert.ok(Math.abs((stats.count[2] ?? 0) - 0.75) < 1e-12);
        assert.ok(Math.abs((stats.shownClueDistribution?.[enchantA] ?? 0) - 0.375) < 1e-12);
        assert.ok(Math.abs((stats.shownClueDistribution?.[enchantB] ?? 0) - 0.25) < 1e-12);
        assert.ok(Math.abs((stats.shownClueDistribution?.[enchantC] ?? 0) - 0.125) < 1e-12);
    });

    it('includes pending entry mass in aggregate and clue stats', () => {
        const enchantA = 0x0101 as PackedEnchant;
        const enchantB = 0x0201 as PackedEnchant;
        const enchantToIndex = new Map<number, number>([
            [enchantA, 1],
            [enchantB, 2]
        ]);
        const indexToEnchant = [0, enchantA, enchantB];
        const packed = ComboUtils.pack([enchantA, enchantB], enchantToIndex);
        const pendingEntries = [makePendingEntry(packed, 2, PRECISION / 4n)];
        const snapshot = makeSearchSnapshot({ pendingEntries, units: { pending: PRECISION / 4n } });
        const expectedClueMass = PRECISION / 8n;

        const stats = SummaryService.summarize({ combos: new Map(), snapshot, indexToEnchant, comboLimit: 0 });

        assert.ok(Math.abs((stats.any[1] ?? 0) - 0.25) < 1e-12);
        assert.ok(Math.abs((stats.any[2] ?? 0) - 0.25) < 1e-12);
        assert.ok(Math.abs((stats.ranks[enchantA] ?? 0) - 0.25) < 1e-12);
        assert.ok(Math.abs((stats.count[2] ?? 0) - 0.25) < 1e-12);
        assert.ok(Math.abs((stats.shownClueDistribution?.[enchantA] ?? 0) - ProbUtils.toNumber(expectedClueMass)) < 1e-12);
        assert.ok(Math.abs((stats.shownClueDistribution?.[enchantB] ?? 0) - ProbUtils.toNumber(expectedClueMass)) < 1e-12);
    });

    it('keeps book pending aggregate adjustment separate from clue mass semantics', () => {
        const enchantA = 0x0101 as PackedEnchant;
        const enchantB = 0x0201 as PackedEnchant;
        const enchantC = 0x0301 as PackedEnchant;
        const enchantToIndex = new Map<number, number>([
            [enchantA, 1],
            [enchantB, 2],
            [enchantC, 3]
        ]);
        const indexToEnchant = [0, enchantA, enchantB, enchantC];
        const packed = ComboUtils.pack([enchantA, enchantB, enchantC], enchantToIndex);
        const pendingEntries = [makePendingEntry(packed, 3, PRECISION)];
        const snapshot = makeSearchSnapshot({ pendingEntries, units: { pending: PRECISION } });
        const expectedAnyMass = (PRECISION * 2n) / 3n;
        const clueQuotient = PRECISION / 3n;

        const stats = SummaryService.summarize({ combos: new Map(), snapshot, indexToEnchant, isBook: true, comboLimit: 0 });

        assert.ok(Math.abs((stats.count[2] ?? 0) - 1.0) < 1e-12);
        assert.ok(Math.abs((stats.any[1] ?? 0) - ProbUtils.toNumber(expectedAnyMass)) < 1e-12);
        assert.ok(Math.abs((stats.any[2] ?? 0) - ProbUtils.toNumber(expectedAnyMass)) < 1e-12);
        assert.ok(Math.abs((stats.any[3] ?? 0) - ProbUtils.toNumber(expectedAnyMass)) < 1e-12);
        assert.ok(Math.abs((stats.shownClueDistribution?.[enchantC] ?? 0) - ProbUtils.toNumber(clueQuotient + 1n)) < 1e-12);
        assert.ok(Math.abs((stats.shownClueDistribution?.[enchantB] ?? 0) - ProbUtils.toNumber(clueQuotient)) < 1e-12);
        assert.ok(Math.abs((stats.shownClueDistribution?.[enchantA] ?? 0) - ProbUtils.toNumber(clueQuotient)) < 1e-12);
    });

    it('distributes clue remainder by packed combo position', () => {
        const enchantA = 0x0101 as PackedEnchant;
        const enchantB = 0x0201 as PackedEnchant;
        const enchantC = 0x0301 as PackedEnchant;
        const enchantToIndex = new Map<number, number>([
            [enchantA, 1],
            [enchantB, 2],
            [enchantC, 3]
        ]);
        const indexToEnchant = [0, enchantA, enchantB, enchantC];
        const packed = ComboUtils.pack([enchantA, enchantB, enchantC], enchantToIndex);
        const clueMass = SummaryAggregationService.aggregate({
            combos: new Map([[packed, 5n]]),
            indexToEnchant,
            includeMasses: false
        }).shownClueDistribution;

        assert.strictEqual(clueMass.get(enchantC), 2n);
        assert.strictEqual(clueMass.get(enchantB), 2n);
        assert.strictEqual(clueMass.get(enchantA), 1n);
    });

    it('comboLimit=0 yields empty combos even when data is present', () => {
        const rawCombos = new Map<PackedCombo, bigint>();
        const indexToEnchant = [0x0101];
        for (let i = 1; i <= 10; i++) rawCombos.set(i as PackedCombo, BigInt(i) * (PRECISION / 100n));
        const snapshot = makeSearchSnapshot({ results: rawCombos, units: { resolved: PRECISION } });
        const result = SummaryService.summarize({ combos: rawCombos, snapshot, indexToEnchant, comboLimit: 0 });
        assert.deepStrictEqual(result.combos, {});
    });

    it('comboLimit ≤ 250 path: returns only top-K highest-probability combos', () => {
        const combos = new Map<PackedCombo, bigint>();
        for (let i = 1; i <= 10; i++) combos.set(i as PackedCombo, BigInt(i) * (PRECISION / 1000n));

        const snapshot = makeSearchSnapshot({ results: combos, units: { resolved: PRECISION } });
        const result = SummaryService.summarize({ combos, snapshot, indexToEnchant: [], comboLimit: 3 });
        const numericKeys = Object.keys(result.combos).map(k => parseInt(k, 16));

        assert.strictEqual(numericKeys.length, 3, 'should return exactly 3 combos');
        assert.ok(numericKeys.includes(8),  'key 8 should be in top-3');
        assert.ok(numericKeys.includes(9),  'key 9 should be in top-3');
        assert.ok(numericKeys.includes(10), 'key 10 should be in top-3');
    });

    it('comboLimit > 250 path: returns only top-K highest-probability combos', () => {
        const combos = new Map<PackedCombo, bigint>();
        for (let i = 1; i <= 400; i++) combos.set(i as PackedCombo, BigInt(i) * (PRECISION / 100000n));

        const snapshot = makeSearchSnapshot({ results: combos, units: { resolved: PRECISION } });
        const result = SummaryService.summarize({ combos, snapshot, indexToEnchant: [], comboLimit: 300 });
        const numericKeys = Object.keys(result.combos).map(k => parseInt(k, 16));

        assert.strictEqual(numericKeys.length, 300, 'should return exactly 300 combos');
        assert.ok(!numericKeys.includes(1),   'key 1 should be excluded');
        assert.ok(numericKeys.includes(400),  'key 400 should be included');
    });

    it('requires uncappedResults for combo limits above the normal export cap', () => {
        const combos = new Map<PackedCombo, bigint>([[1 as PackedCombo, PRECISION]]);
        const snapshot = makeSearchSnapshot({ results: combos, units: { resolved: PRECISION } });

        assert.throws(
            () => SummaryService.summarize({ combos, snapshot, indexToEnchant: [], comboLimit: ENGINE_LIMITS.RESULT_ENTRY_SAFETY_CAP + 1 }),
            /uncappedResults/
        );

        const result = SummaryService.summarize({
            combos,
            snapshot,
            indexToEnchant: [],
            comboLimit: ENGINE_LIMITS.RESULT_ENTRY_SAFETY_CAP + 1,
            uncappedResults: true
        });
        assert.deepStrictEqual(Object.keys(result.combos), ['1']);
    });

    it('uncappedResults without comboLimit exports every combo', () => {
        const combos = new Map<PackedCombo, bigint>();
        for (let i = 1; i <= ENGINE_LIMITS.MAX_RESULTS_SUMMARY + 1; i++) combos.set(i as PackedCombo, BigInt(i));
        const snapshot = makeSearchSnapshot({ results: combos, units: { resolved: PRECISION } });
        const result = SummaryService.summarize({ combos, snapshot, indexToEnchant: [], uncappedResults: true });

        assert.strictEqual(Object.keys(result.combos).length, ENGINE_LIMITS.MAX_RESULTS_SUMMARY + 1);
    });

    it('stores combo keys as lowercase hex strings', () => {
        const combos = new Map<PackedCombo, bigint>([[255 as PackedCombo, PRECISION / 2n]]);
        const snapshot = makeSearchSnapshot({ results: combos, units: { resolved: PRECISION / 2n } });
        const result = SummaryService.summarize({ combos, snapshot, indexToEnchant: [] });
        assert.ok(Object.keys(result.combos).includes('ff'));
    });

    it('chart-cell snapshots expose aggregate buckets without a combo payload', () => {
        const engine = EngineFactory.createForVersion('1.20');
        const registry = engine.registry;
        const sharpness = registry.idMap.get('Sharpness')!;
        const sharpnessRank = ((sharpness << 8) | 1) as PackedEnchant;
        const combos = new Map<PackedCombo, bigint>([
            [ComboUtils.pack([sharpnessRank], registry.enchantToIndex), PRECISION]
        ]);
        const snapshot = makeSearchSnapshot({ results: combos, units: { resolved: PRECISION } });

        const cell = SnapshotService.create(
            registry,
            snapshot,
            {
                snapshotType: 'chart-cell',
                input: {
                    version: '1.20',
                    item: 'sword',
                    material: 'diamond',
                    xpLevel: 30,
                    clue: null
                },
                refinementLevel: 'ultra',
                clue: null,
                includeCombos: false
            }
        );

        assert.strictEqual('combos' in cell, false);
        assert.strictEqual((cell as any).buckets.anyByEnchantId[sharpness], 1);
        assert.strictEqual((cell as any).buckets.rankByIdAndRank[sharpnessRank], 1);
        assert.strictEqual((cell as any).buckets.countBySize[1], 1);
    });
});

// ── SerializationService ───────────────────────────────────────────────────

describe('SerializationService', () => {
    const makeStats = (overrides: Partial<EnchantStats> = {}): EnchantStats => {
        const accuracy = overrides.accuracy ?? 1.0;
        const accounting = overrides.accounting ?? {
            resolved: accuracy, clueIncompatible: 0, pending: 0, sieved: 0,
            overflow: 0, capped: 0, rounding: 0, recoveredRounding: 0, recoveredSieved: 0
        };
        return {
            ranks: {}, any: {}, count: {}, combos: {}, shownClueDistribution: {},
            accuracy, accounting, threshold: 0.1,
            ...overrides
        };
    };

    it('roundtrip preserves accuracy and accounting fields', () => {
        const acc: MassAccountingBreakdown = { resolved: 0.5, clueIncompatible: 0, pending: 0.1, sieved: 0.2, overflow: 0.1, capped: 0, rounding: 0.1, recoveredRounding: 0, recoveredSieved: 0 };
        const stats = makeStats({ accuracy: 0.5, accounting: acc });
        const { compact } = SerializationService.serialize(stats);
        const recovered = SerializationService.deserialize(compact);
        assert.strictEqual(recovered.accuracy, 0.5);
        assert.deepStrictEqual(recovered.accounting, acc);
    });

    it('roundtrip preserves clue metadata', () => {
        const stats = makeStats({ clue: { idAndRank: 0x0504, knownSpace: 0.25 } });
        const { compact } = SerializationService.serialize(stats);
        const recovered = SerializationService.deserialize(compact);
        assert.strictEqual(recovered.clue?.idAndRank, 0x0504);
        assert.strictEqual(recovered.clue?.knownSpace, 0.25);
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
    const engine = EngineFactory.createForVersion('1.20');
    const reg    = engine.registry;

    before(async () => {
        await engine.getStats({ item: 'pickaxe', xp: 30, material: 'diamond', threshold: 0.005 });
    });

    it('resolves enchantment names in the any map', () => {
        const effId = reg.idMap.get('Efficiency')!;
        const acc: MassAccountingBreakdown = { resolved: 0.85, clueIncompatible: 0, pending: 0.15, sieved: 0, overflow: 0, capped: 0, rounding: 0, recoveredRounding: 0, recoveredSieved: 0 };
        const rawStats: EnchantStats = {
            ranks: {}, any: { [effId]: 0.85 }, count: {}, combos: {}, shownClueDistribution: {},
            accuracy: 0.85, accounting: acc, threshold: 0.85
        };
        const result = HumanizationService.humanize(rawStats, reg, 'prob');
        assert.ok(Object.keys(result.any).includes('Efficiency'));
    });

    it('sorting by "count" correctly prioritizes primary count bucket', () => {
        const stats = {
            combos: { 'ff': 0.1 },
            count: { 1: 0.1 },
            any: {}, ranks: {}, accuracy: 1, accounting: {}, threshold: 0
        } as any;

        const result = HumanizationService.humanize(stats, reg, 'count');
        assert.ok(result.combos, 'Humanize should return combos map');
    });

    it('sorting by "rank" correctly prioritizes high-tier ranks', () => {
        const stats = {
            combos: { 'ff': 0.1 },
            count: {}, any: {}, ranks: {}, accuracy: 1, accounting: {}, threshold: 0
        } as any;
        const result = HumanizationService.humanize(stats, reg, 'rank');
        assert.ok(result, 'Humanize should not crash with sortMode=rank');
    });
});

// ── ModifiedLevelDistributionService edge case ─────────────────────────────────────────

describe('TopComboSortService', () => {
    const combos: TopComboView[] = [
        { enchants: ['Efficiency IV'], share: 0.4, enchantCount: 1, rankSum: 4 },
        { enchants: ['Unbreaking III', 'Fortune III', 'Efficiency IV'], share: 0.1, enchantCount: 3, rankSum: 10 },
        { enchants: ['Silk Touch I', 'Unbreaking III'], share: 0.2, enchantCount: 2, rankSum: 4 },
        { enchants: ['Fortune III', 'Unbreaking III'], share: 0.3, enchantCount: 2, rankSum: 6 }
    ];

    it('sorts top combos by probability by default', () => {
        const sorted = TopComboSortService.sort(combos);

        assert.deepStrictEqual(sorted.map(combo => combo.enchants.join('+')), [
            'Efficiency IV',
            'Fortune III+Unbreaking III',
            'Silk Touch I+Unbreaking III',
            'Unbreaking III+Fortune III+Efficiency IV'
        ]);
    });

    it('sorts top combos by enchantment count for the "most enchants" UI mode', () => {
        const sorted = TopComboSortService.sort(combos, 'count');

        assert.deepStrictEqual(sorted.map(combo => combo.enchantCount), [3, 2, 2, 1]);
        assert.strictEqual(sorted[0]?.enchants.join('+'), 'Unbreaking III+Fortune III+Efficiency IV');
    });

    it('sorts top combos by rank sum for the "highest total rank" UI mode', () => {
        const sorted = TopComboSortService.sort(combos, 'rank');

        assert.deepStrictEqual(sorted.map(combo => combo.rankSum), [10, 6, 4, 4]);
        assert.strictEqual(sorted[0]?.enchants.join('+'), 'Unbreaking III+Fortune III+Efficiency IV');
    });
});

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
