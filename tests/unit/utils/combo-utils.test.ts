/**
 * Direct unit tests for ComboUtils (pack/unpack/removeAdditional).
 *
 * ComboUtils methods now accept enchantToIndex / indexToEnchant explicitly.
 * We initialize these by constructing a real engine, which guarantees
 * the same mappings used in production.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { PackedEnchant, PackedCombo } from '#types/index.js';
import { ComboUtils } from '#utils/domain/ComboUtils.js';

// Build once at module level.
const engine = EngineFactory.createForVersion('1.21');
const reg = engine.registry;

/** Returns a PackedEnchant value: (enchant_id << 8) | rank */
const pe = (name: string, rank: number): PackedEnchant => ((reg.idMap.get(name)! << 8) | rank) as PackedEnchant;

describe('ComboUtils', () => {
    // ── Helpers ──────────────────────────────────────────────────────────────

    let SHARP4: PackedEnchant, UNBR3: PackedEnchant, FIRE2: PackedEnchant;
    let SHARP_ID: number, UNBR_ID: number;

    before(() => {
        SHARP4  = pe('Sharpness', 4);
        UNBR3   = pe('Unbreaking', 3);
        FIRE2   = pe('Fire Aspect', 2);

        SHARP_ID = reg.idMap.get('Sharpness')!;
        UNBR_ID  = reg.idMap.get('Unbreaking')!;
    });

    // ── getEnchantId / getEnchantRank ─────────────────────────────────────

    it('getEnchantId extracts the enchantment id', () => {
        assert.strictEqual(ComboUtils.getEnchantId(SHARP4), SHARP_ID);
        assert.strictEqual(ComboUtils.getEnchantId(UNBR3),  UNBR_ID);
    });

    it('getEnchantRank extracts the rank', () => {
        assert.strictEqual(ComboUtils.getEnchantRank(SHARP4), 4);
        assert.strictEqual(ComboUtils.getEnchantRank(UNBR3),  3);
        assert.strictEqual(ComboUtils.getEnchantRank(FIRE2),  2);
    });

    // ── pack / unpack ─────────────────────────────────────────────────────

    it('pack([]) === 0', () => {
        assert.strictEqual(ComboUtils.pack([], reg.enchantToIndex), (0 as PackedCombo));
    });

    it('unpack(0) returns empty array', () => {
        assert.deepStrictEqual(ComboUtils.unpack((0 as PackedCombo), reg.indexToEnchant), []);
    });

    it('getCount returns correct count for 1–3 enchants', () => {
        assert.strictEqual(ComboUtils.getCount(ComboUtils.pack([SHARP4], reg.enchantToIndex)),               1);
        assert.strictEqual(ComboUtils.getCount(ComboUtils.pack([SHARP4, UNBR3], reg.enchantToIndex)),        2);
        assert.strictEqual(ComboUtils.getCount(ComboUtils.pack([SHARP4, UNBR3, FIRE2], reg.enchantToIndex)), 3);
    });

    it('packAppendIndex matches packAppend for empty, front, middle, and end insertion', () => {
        const itemA = ((1 << 8) | 1) as PackedEnchant;
        const itemB = ((2 << 8) | 1) as PackedEnchant;
        const itemC = ((3 << 8) | 1) as PackedEnchant;
        const itemD = ((4 << 8) | 1) as PackedEnchant;
        const customMap = new Map<number, number>([
            [itemA, 1],
            [itemB, 3],
            [itemC, 5],
            [itemD, 7]
        ]);

        const cases: Array<{ existing: PackedEnchant[]; next: PackedEnchant }> = [
            { existing: [], next: itemC },
            { existing: [itemA, itemB], next: itemD },
            { existing: [itemA, itemD], next: itemB },
            { existing: [itemC, itemD], next: itemA }
        ];

        for (const testCase of cases) {
            const existing = ComboUtils.pack(testCase.existing, customMap);
            const nextIndex = customMap.get(testCase.next)!;
            assert.strictEqual(
                ComboUtils.packAppendIndex(existing, nextIndex, ComboUtils.getCount(existing)),
                ComboUtils.packAppend(existing, testCase.next, customMap)
            );
        }
    });

    it('forEachEnchant matches unpack order without allocating an array', () => {
        const packed = ComboUtils.pack([SHARP4, UNBR3, FIRE2], reg.enchantToIndex);
        const scanned: PackedEnchant[] = [];

        const count = ComboUtils.forEachEnchant(packed, reg.indexToEnchant, enchant => {
            scanned.push(enchant);
        });

        assert.strictEqual(count, ComboUtils.getCount(packed));
        assert.deepStrictEqual(scanned, ComboUtils.unpack(packed, reg.indexToEnchant));
    });

    // ── removeAdditional ──────────────────────────────────────────────────

    it('removeAdditional on single-enchant combo returns same combo', () => {
        const packed  = ComboUtils.pack([SHARP4], reg.enchantToIndex);
        const results = ComboUtils.removeAdditional(packed);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0]!, packed);
    });

    it('removeAdditional on empty combo returns [0]', () => {
        const results = ComboUtils.removeAdditional((0 as PackedCombo));
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0]!, (0 as PackedCombo));
    });

    it('removeAdditional returns N results for N-enchant input', () => {
        const input   = [SHARP4, UNBR3, FIRE2];
        const packed  = ComboUtils.pack(input, reg.enchantToIndex);
        const results = ComboUtils.removeAdditional(packed);

        assert.strictEqual(results.length, 3);
        // Each result has exactly 2 enchants
        for (const r of results) {
            assert.strictEqual(ComboUtils.getCount(r), 2);
        }
    });

    it('each original enchant is absent from exactly one result', () => {
        const input   = [SHARP4, UNBR3, FIRE2];
        const packed  = ComboUtils.pack(input, reg.enchantToIndex);
        const results = ComboUtils.removeAdditional(packed);

        // Each of the 3 input enchants should be absent from exactly 1 of the 3 results
        for (const enchant of input) {
            const id      = enchant >> 8;
            const absent  = results.filter(r => !ComboUtils.unpack(r, reg.indexToEnchant).some(e => (e >> 8) === id));
            assert.strictEqual(absent.length, 1, `enchant id=${id} should be absent from exactly 1 result`);
        }
    });
});
