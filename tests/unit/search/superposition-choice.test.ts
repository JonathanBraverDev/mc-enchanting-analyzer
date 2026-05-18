import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { PackedEnchant } from '#types/index.js';
import {
    canonicalizeChoiceSet,
    canonicalizePackedEnchantList,
    comparePackedEnchantLists,
    sameChoiceSet,
    samePackedEnchantList
} from '#lib/search/superposition/SuperpositionChoice.js';

const packed = (value: number): PackedEnchant => value as PackedEnchant;

describe('superposition choice helpers', () => {
    it('canonicalizes one choice list by packed enchant value without mutating input', () => {
        const input = [packed(30), packed(10), packed(20)] as const;
        const canonical = canonicalizePackedEnchantList(input);

        assert.deepStrictEqual([...canonical], [packed(10), packed(20), packed(30)]);
        assert.deepStrictEqual([...input], [packed(30), packed(10), packed(20)]);
    });

    it('compares canonical packed enchant lists exactly', () => {
        const left = canonicalizePackedEnchantList([packed(3), packed(1), packed(2)]);
        const equal = canonicalizePackedEnchantList([packed(1), packed(2), packed(3)]);
        const different = canonicalizePackedEnchantList([packed(1), packed(2), packed(4)]);

        assert.strictEqual(samePackedEnchantList(left, equal), true);
        assert.strictEqual(samePackedEnchantList(left, different), false);
    });

    it('sorts choice lists lexicographically for order-insensitive choose-set equality', () => {
        const protection = [packed(100), packed(110), packed(120)];
        const damage = [packed(10), packed(20), packed(30)];
        const first = canonicalizeChoiceSet([protection, damage]);
        const second = canonicalizeChoiceSet([damage, protection]);

        assert.strictEqual(sameChoiceSet(first, second), true);
        assert.deepStrictEqual([...first[0]!], [packed(10), packed(20), packed(30)]);
        assert.deepStrictEqual([...first[1]!], [packed(100), packed(110), packed(120)]);
    });

    it('uses later elements and length as deterministic tie breakers', () => {
        const shorter = canonicalizePackedEnchantList([packed(1), packed(2)]);
        const longer = canonicalizePackedEnchantList([packed(1), packed(2), packed(3)]);
        const differentSecond = canonicalizePackedEnchantList([packed(1), packed(4)]);

        assert.ok(comparePackedEnchantLists(shorter, longer) < 0);
        assert.ok(comparePackedEnchantLists(differentSecond, longer) > 0);
    });

    it('rejects duplicate alternatives inside one choice list', () => {
        assert.throws(
            () => canonicalizePackedEnchantList([packed(1), packed(2), packed(1)]),
            /Duplicate PackedEnchant 1/
        );
    });
});
