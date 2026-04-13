/**
 * Direct unit tests for ComboUtils (pack/unpack/removeAdditional).
 *
 * ComboUtils methods now accept enchantToIndex / indexToEnchant explicitly.
 * We initialize these by constructing a real EnchantEngine, which guarantees
 * the same mappings used in production.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine, EngineFactory } from '../src/lib/engine/index.js';
import { DATA } from '../src/lib/data/index.js';
import { PackedEnchant, PackedCombo } from '../src/lib/types/index.js';
import { ComboUtils } from '../src/lib/utils/domain/ComboUtils.js';

// Build once at module level.
const engine = EngineFactory.create(DATA, '1.21');
const reg = engine.registry;

/** Returns a PackedEnchant value: (enchant_id << 8) | rank */
const pe = (name: string, rank: number): PackedEnchant => ((reg.idMap.get(name)! << 8) | rank) as PackedEnchant;

describe('ComboUtils', () => {
    // ── Helpers ──────────────────────────────────────────────────────────────

    let SHARP4: PackedEnchant, UNBR3: PackedEnchant, FIRE2: PackedEnchant, FORT3: PackedEnchant;
    let SHARP_ID: number, UNBR_ID: number;

    before(() => {
        SHARP4  = pe('Sharpness', 4);
        UNBR3   = pe('Unbreaking', 3);
        FIRE2   = pe('Fire Aspect', 2);
        FORT3   = pe('Fortune', 3);

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

    it('pack([], null) === 0', () => {
        assert.strictEqual(ComboUtils.pack([], null, reg.enchantToIndex), (0 as PackedCombo));
    });

    it('unpack(0) returns empty array', () => {
        assert.deepStrictEqual(ComboUtils.unpack((0 as PackedCombo), reg.indexToEnchant), []);
    });

    it('pack/unpack roundtrip — single enchant', () => {
        const packed   = ComboUtils.pack([SHARP4], null, reg.enchantToIndex);
        const unpacked = ComboUtils.unpack(packed, reg.indexToEnchant);
        assert.strictEqual(unpacked.length, 1);
        assert.strictEqual(unpacked[0], SHARP4);
    });

    it('pack/unpack roundtrip — two enchants preserves both elements', () => {
        const input  = [SHARP4, UNBR3];
        const packed = ComboUtils.pack(input, null, reg.enchantToIndex);

        const unpacked = ComboUtils.unpack(packed, reg.indexToEnchant);
        assert.strictEqual(unpacked.length, 2);
        assert.deepStrictEqual(new Set(unpacked), new Set(input));
    });

    it('pack/unpack roundtrip — three enchants preserves all elements', () => {
        const input  = [SHARP4, UNBR3, FIRE2];
        const packed = ComboUtils.pack(input, null, reg.enchantToIndex);

        const unpacked = ComboUtils.unpack(packed, reg.indexToEnchant);
        assert.strictEqual(unpacked.length, 3);
        assert.deepStrictEqual(new Set(unpacked), new Set(input));
    });

    it('pack → unpack → pack produces the same numeric key (stable roundtrip)', () => {
        const input  = [SHARP4, UNBR3, FIRE2];
        const p1     = ComboUtils.pack(input, null, reg.enchantToIndex);
        const p2     = ComboUtils.pack(ComboUtils.unpack(p1, reg.indexToEnchant), null, reg.enchantToIndex);
        assert.strictEqual(p1, p2);
    });

    // ── getCount ──────────────────────────────────────────────────────────

    it('getCount returns 0 for empty combo', () => {
        assert.strictEqual(ComboUtils.getCount((0 as PackedCombo)), 0);
    });

    it('getCount returns correct count for 1–3 enchants', () => {
        assert.strictEqual(ComboUtils.getCount(ComboUtils.pack([SHARP4], null, reg.enchantToIndex)),               1);
        assert.strictEqual(ComboUtils.getCount(ComboUtils.pack([SHARP4, UNBR3], null, reg.enchantToIndex)),        2);
        assert.strictEqual(ComboUtils.getCount(ComboUtils.pack([SHARP4, UNBR3, FIRE2], null, reg.enchantToIndex)), 3);
    });

    // ── guaranteed-first slot encoding ───────────────────────────────────

    it('pack with guaranteedFirstId places that enchant at slot 0 of unpack', () => {
        // Arrange: pack three enchants with UNBR as the guaranteed first
        const packed   = ComboUtils.pack([SHARP4, UNBR3, FIRE2], UNBR_ID, reg.enchantToIndex);
        const unpacked = ComboUtils.unpack(packed, reg.indexToEnchant);

        // The first element must be UNBREAKING
        assert.strictEqual(ComboUtils.getEnchantId(unpacked[0]), UNBR_ID);
        // All three enchants still present
        assert.deepStrictEqual(new Set(unpacked), new Set([SHARP4, UNBR3, FIRE2]));
    });

    it('guaranteed-first slot differs from no-guarantee ordering when guaranteed is not highest-index', () => {
        // Without guarantee the highest-index enchant goes to slot 0.
        // With guarantee=SHARP_ID, SHARP should be first regardless of index order.
        const packedGuaranteed = ComboUtils.pack([SHARP4, FORT3], SHARP_ID, reg.enchantToIndex);
        const packedFree       = ComboUtils.pack([SHARP4, FORT3], null, reg.enchantToIndex);

        const firstGuaranteed = ComboUtils.getEnchantId(ComboUtils.unpack(packedGuaranteed, reg.indexToEnchant)[0]);
        assert.strictEqual(firstGuaranteed, SHARP_ID);

        // The free-order encoding is a valid combo with both enchants
        const freePacked = ComboUtils.unpack(packedFree, reg.indexToEnchant);
        assert.deepStrictEqual(new Set(freePacked), new Set([SHARP4, FORT3]));
    });

    // ── removeAdditional ──────────────────────────────────────────────────

    it('removeAdditional on single-enchant combo returns same combo', () => {
        const packed  = ComboUtils.pack([SHARP4], null, reg.enchantToIndex);
        const results = ComboUtils.removeAdditional(packed, null, reg.indexToEnchant);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0], packed);
    });

    it('removeAdditional on empty combo returns [0]', () => {
        const results = ComboUtils.removeAdditional((0 as PackedCombo), null, reg.indexToEnchant);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0], (0 as PackedCombo));
    });

    it('removeAdditional without guarantee returns N results for N-enchant input', () => {
        const input   = [SHARP4, UNBR3, FIRE2];
        const packed  = ComboUtils.pack(input, null, reg.enchantToIndex);
        const results = ComboUtils.removeAdditional(packed, null, reg.indexToEnchant);

        assert.strictEqual(results.length, 3);
        // Each result has exactly 2 enchants
        for (const r of results) {
            assert.strictEqual(ComboUtils.getCount(r), 2);
        }
    });

    it('removeAdditional without guarantee: each original enchant is absent from exactly one result', () => {
        const input   = [SHARP4, UNBR3, FIRE2];
        const packed  = ComboUtils.pack(input, null, reg.enchantToIndex);
        const results = ComboUtils.removeAdditional(packed, null, reg.indexToEnchant);

        // Each of the 3 input enchants should be absent from exactly 1 of the 3 results
        for (const enchant of input) {
            const id      = enchant >> 8;
            const absent  = results.filter(r => !ComboUtils.unpack(r, reg.indexToEnchant).some(e => (e >> 8) === id));
            assert.strictEqual(absent.length, 1, `enchant id=${id} should be absent from exactly 1 result`);
        }
    });

    it('removeAdditional with guaranteedFirstId returns only results containing the guaranteed enchant', () => {
        const input   = [SHARP4, UNBR3, FIRE2];
        const packed  = ComboUtils.pack(input, null, reg.enchantToIndex);
        const results = ComboUtils.removeAdditional(packed, SHARP_ID, reg.indexToEnchant);

        // Every result must contain SHARPNESS
        for (const r of results) {
            const ids = ComboUtils.unpack(r, reg.indexToEnchant).map(e => e >> 8);
            assert.ok(ids.includes(SHARP_ID), 'guaranteed enchant must be present in all filtered results');
        }
        // The result where SHARPNESS was removed is excluded → only N-1 = 2 results
        assert.strictEqual(results.length, 2);
    });

    it('removeAdditional guarantee: result that would remove the guaranteed enchant is excluded', () => {
        const input   = [SHARP4, UNBR3];
        const packed  = ComboUtils.pack(input, null, reg.enchantToIndex);

        // Without guarantee: 2 results (one with only UNBR, one with only SHARP)
        const noGuarantee = ComboUtils.removeAdditional(packed, null, reg.indexToEnchant);
        assert.strictEqual(noGuarantee.length, 2);

        // With guarantee=SHARP: only 1 result (the one that still has SHARP)
        const withGuarantee = ComboUtils.removeAdditional(packed, SHARP_ID, reg.indexToEnchant);
        assert.strictEqual(withGuarantee.length, 1);

        const ids = ComboUtils.unpack(withGuarantee[0], reg.indexToEnchant).map(e => e >> 8);
        assert.ok(ids.includes(SHARP_ID));
    });
});
