/**
 * Unit tests for pure utility functions:
 * ProbUtils, VersionUtils, StringUtils, UIUtils, RomanUtils
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ProbUtils, PRECISION } from '#utils/math/ProbUtils.js';
import { VersionUtils } from '#utils/domain/VersionUtils.js';
import { StringUtils, UIUtils } from '#utils/format/FormatUtils.js';
import { RomanUtils } from '#utils/format/RomanUtils.js';
import { KeyUtils, KEY_SHIFT_LEVEL } from '#utils/domain/KeyUtils.js';
import { EnchantUtils } from '#utils/domain/EnchantUtils.js';

const ROMAN_MAP = { "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5 };

// ── ProbUtils ────────────────────────────────────────────────────────────────

describe('ProbUtils', () => {
    it('PRECISION is 2^60', () => {
        assert.strictEqual(PRECISION, 1n << 60n);
    });

    it('toBigInt(0) === 0n', () => {
        assert.strictEqual(ProbUtils.toBigInt(0), 0n);
    });

    it('toBigInt(1) === PRECISION', () => {
        assert.strictEqual(ProbUtils.toBigInt(1), PRECISION);
    });

    it('toNumber(0n) === 0', () => {
        assert.strictEqual(ProbUtils.toNumber(0n), 0);
    });

    it('toNumber(PRECISION) === 1.0', () => {
        assert.strictEqual(ProbUtils.toNumber(PRECISION), 1.0);
    });

    it('toNumber(toBigInt(p)) ≈ p for common probabilities', () => {
        for (const p of [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0]) {
            const roundtrip = ProbUtils.toNumber(ProbUtils.toBigInt(p));
            assert.ok(
                Math.abs(roundtrip - p) < 1e-12,
                `roundtrip failed for p=${p}: got ${roundtrip}`
            );
        }
    });

    it('scale(PRECISION, PRECISION) === PRECISION', () => {
        assert.strictEqual(ProbUtils.scale(PRECISION, PRECISION), PRECISION);
    });

    it('scale(0n, PRECISION) === 0n', () => {
        assert.strictEqual(ProbUtils.scale(0n, PRECISION), 0n);
    });

    it('scale(PRECISION, 0n) === 0n', () => {
        assert.strictEqual(ProbUtils.scale(PRECISION, 0n), 0n);
    });

    it('scale(half, half) ≈ PRECISION/4 (within BigInt truncation)', () => {
        const half = PRECISION / 2n;
        const result = ProbUtils.scale(half, half);
        const quarter = PRECISION / 4n;
        // BigInt division truncates, so allow ±1
        assert.ok(
            result >= quarter - 1n && result <= quarter + 1n,
            `expected ~PRECISION/4, got ${result}`
        );
    });

    it('scale is proportional: scale(p, q) = scale(q, p)', () => {
        const p = PRECISION / 3n;
        const q = PRECISION / 7n;
        assert.strictEqual(ProbUtils.scale(p, q), ProbUtils.scale(q, p));
    });
});

// ── VersionUtils ─────────────────────────────────────────────────────────────

describe('VersionUtils.parse', () => {
    it('parses a three-part version string', () => {
        assert.deepStrictEqual(VersionUtils.parse('1.2.3'), [1, 2, 3]);
    });

    it('parses a two-part version string', () => {
        assert.deepStrictEqual(VersionUtils.parse('1.8'), [1, 8]);
    });

    it('parses a two-part version with zero minor', () => {
        assert.deepStrictEqual(VersionUtils.parse('1.0'), [1, 0]);
    });

    it('returns empty array for empty string', () => {
        assert.deepStrictEqual(VersionUtils.parse(''), []);
    });
});

describe('VersionUtils.compare', () => {
    it('returns 0 for identical versions', () => {
        assert.strictEqual(VersionUtils.compare('1.8', '1.8'), 0);
        assert.strictEqual(VersionUtils.compare('1.14.3', '1.14.3'), 0);
    });

    it('returns 1 when v1 > v2', () => {
        assert.strictEqual(VersionUtils.compare('1.9', '1.8'), 1);
        assert.strictEqual(VersionUtils.compare('2.0', '1.99'), 1);
    });

    it('returns -1 when v1 < v2', () => {
        assert.strictEqual(VersionUtils.compare('1.8', '1.9'), -1);
        assert.strictEqual(VersionUtils.compare('1.99', '2.0'), -1);
    });

    it('uses numeric (not lexicographic) comparison: 1.9 < 1.10', () => {
        // Lexicographic: "10" < "9" (wrong); numeric: 10 > 9 (correct)
        assert.strictEqual(VersionUtils.compare('1.9', '1.10'), -1);
        assert.strictEqual(VersionUtils.compare('1.10', '1.9'), 1);
    });

    it('handles versions of different part-counts: 1.0 < 1.0.1', () => {
        assert.strictEqual(VersionUtils.compare('1.0', '1.0.1'), -1);
        assert.strictEqual(VersionUtils.compare('1.0.1', '1.0'), 1);
    });

    it('three-part versions compare correctly', () => {
        assert.strictEqual(VersionUtils.compare('1.14.3', '1.14'), 1);
        assert.strictEqual(VersionUtils.compare('1.14', '1.14.3'), -1);
        assert.strictEqual(VersionUtils.compare('1.21.11', '1.21.9'), 1);
    });
});

describe('VersionUtils.isInRange', () => {
    it('returns true when start is undefined (always in range)', () => {
        assert.strictEqual(VersionUtils.isInRange('1.0'), true);
        assert.strictEqual(VersionUtils.isInRange('99.99'), true);
    });

    it('returns true when version equals start boundary', () => {
        assert.strictEqual(VersionUtils.isInRange('1.8', '1.8'), true);
    });

    it('returns false when version is before start', () => {
        assert.strictEqual(VersionUtils.isInRange('1.7', '1.8'), false);
        assert.strictEqual(VersionUtils.isInRange('1.0', '1.8'), false);
    });

    it('returns true when version is at or after start (no explicit end)', () => {
        assert.strictEqual(VersionUtils.isInRange('1.21', '1.8'), true);
        assert.strictEqual(VersionUtils.isInRange('1.8', '1.8'), true);
    });

    it('returns false when version exceeds explicit end', () => {
        assert.strictEqual(VersionUtils.isInRange('1.11', '1.8', '1.10'), false);
    });

    it('returns true when version equals explicit end', () => {
        assert.strictEqual(VersionUtils.isInRange('1.10', '1.8', '1.10'), true);
    });

    it('returns true when version is within explicit range', () => {
        assert.strictEqual(VersionUtils.isInRange('1.9', '1.8', '1.10'), true);
    });
});

// ── StringUtils ──────────────────────────────────────────────────────────────

describe('StringUtils.toTitleCase', () => {
    it('capitalizes a single word', () => {
        assert.strictEqual(StringUtils.toTitleCase('unbreaking'), 'Unbreaking');
    });

    it('converts two-word snake_case slug', () => {
        assert.strictEqual(StringUtils.toTitleCase('fire_aspect'), 'Fire Aspect');
    });

    it('converts three-word slug', () => {
        assert.strictEqual(StringUtils.toTitleCase('bane_of_arthropods'), 'Bane Of Arthropods');
    });

    it('empty string returns empty string', () => {
        assert.strictEqual(StringUtils.toTitleCase(''), '');
    });

    it('already-uppercase first letter is preserved', () => {
        assert.strictEqual(StringUtils.toTitleCase('Sharpness'), 'Sharpness');
    });
});

// ── UIUtils ──────────────────────────────────────────────────────────────────

describe('UIUtils.formatPercent', () => {
    it('formats 0.5 as "50.0%"', () => {
        assert.strictEqual(UIUtils.formatPercent(0.5), '50.0%');
    });

    it('formats 1.0 as "100.0%"', () => {
        assert.strictEqual(UIUtils.formatPercent(1.0), '100.0%');
    });

    it('formats 0 as "0.0%"', () => {
        assert.strictEqual(UIUtils.formatPercent(0), '0.0%');
    });

    it('formats 0.123 as "12.3%"', () => {
        assert.strictEqual(UIUtils.formatPercent(0.123), '12.3%');
    });

    it('rounds to one decimal place', () => {
        // 0.1234 * 100 = 12.34 → toFixed(1) → "12.3"
        assert.strictEqual(UIUtils.formatPercent(0.1234), '12.3%');
        // 0.1235 * 100 = 12.35 → toFixed(1) → "12.4" (JS banker's rounding may vary)
        const result = UIUtils.formatPercent(0.0001);
        assert.ok(result.endsWith('%'), 'should always end with %');
    });
});

// ── RomanUtils ───────────────────────────────────────────────────────────────

describe('RomanUtils.rankToRoman', () => {
    it('converts ranks 1-5 to I-V', () => {
        assert.strictEqual(RomanUtils.rankToRoman(1, ROMAN_MAP), 'I');
        assert.strictEqual(RomanUtils.rankToRoman(2, ROMAN_MAP), 'II');
        assert.strictEqual(RomanUtils.rankToRoman(3, ROMAN_MAP), 'III');
        assert.strictEqual(RomanUtils.rankToRoman(4, ROMAN_MAP), 'IV');
        assert.strictEqual(RomanUtils.rankToRoman(5, ROMAN_MAP), 'V');
    });

    it('throws for out-of-range ranks', () => {
        assert.throws(() => RomanUtils.rankToRoman(0, ROMAN_MAP), /Invalid rank/);
        assert.throws(() => RomanUtils.rankToRoman(6, ROMAN_MAP), /Invalid rank/);
    });
});

describe('RomanUtils.getRomanValue', () => {
    it('returns correct numeric value for known Roman numerals', () => {
        assert.strictEqual(RomanUtils.getRomanValue('I', ROMAN_MAP), 1);
        assert.strictEqual(RomanUtils.getRomanValue('II', ROMAN_MAP), 2);
        assert.strictEqual(RomanUtils.getRomanValue('V', ROMAN_MAP), 5);
    });

    it('throws for unknown strings', () => {
        assert.throws(() => RomanUtils.getRomanValue('X', ROMAN_MAP), /Invalid Roman numeral/);
        assert.throws(() => RomanUtils.getRomanValue('', ROMAN_MAP), /Invalid Roman numeral/);
        assert.throws(() => RomanUtils.getRomanValue('VI', ROMAN_MAP), /Invalid Roman numeral/);
    });
});

describe('RomanUtils.getBaseName', () => {
    it('strips trailing Roman numeral from enchantment name', () => {
        assert.strictEqual(RomanUtils.getBaseName('Sharpness V', ROMAN_MAP), 'Sharpness');
        assert.strictEqual(RomanUtils.getBaseName('Fire Aspect II', ROMAN_MAP), 'Fire Aspect');
        assert.strictEqual(RomanUtils.getBaseName('Efficiency IV', ROMAN_MAP), 'Efficiency');
        assert.strictEqual(RomanUtils.getBaseName('Protection I', ROMAN_MAP), 'Protection');
    });

    it('returns full name when no trailing Roman numeral is present', () => {
        assert.strictEqual(RomanUtils.getBaseName('Unbreaking', ROMAN_MAP), 'Unbreaking');
        assert.strictEqual(RomanUtils.getBaseName('Silk Touch', ROMAN_MAP), 'Silk Touch');
    });

    it('does not strip a non-Roman-numeral last word', () => {
        assert.strictEqual(RomanUtils.getBaseName('Sharpness Max', ROMAN_MAP), 'Sharpness Max');
    });
});

// ── KeyUtils ─────────────────────────────────────────────────────────────────

describe('KeyUtils.getPackedKey', () => {
    it('produces the same key for identical inputs', () => {
        const k1 = KeyUtils.getPackedKey(1, 2, 15);
        const k2 = KeyUtils.getPackedKey(1, 2, 15);
        assert.strictEqual(k1, k2);
    });

    it('produces different keys for different catId', () => {
        const k1 = KeyUtils.getPackedKey(0, 2, 15);
        const k2 = KeyUtils.getPackedKey(1, 2, 15);
        assert.notStrictEqual(k1, k2);
    });

    it('produces different keys for different matId', () => {
        const k1 = KeyUtils.getPackedKey(1, 0, 15);
        const k2 = KeyUtils.getPackedKey(1, 1, 15);
        assert.notStrictEqual(k1, k2);
    });

    it('produces different keys for different modLevel', () => {
        const k1 = KeyUtils.getPackedKey(1, 2, 10);
        const k2 = KeyUtils.getPackedKey(1, 2, 20);
        assert.notStrictEqual(k1, k2);
    });

    it('produces the same key regardless of search limit (cross-tier resumability)', () => {
        // limit is NOT part of the packed key — coarse and deep tiers share one cache entry
        const kCoarse = KeyUtils.getPackedKey(1, 2, 15);
        const kDeep   = KeyUtils.getPackedKey(1, 2, 15);
        assert.strictEqual(kCoarse, kDeep);
    });

    it('encodes modLevel in the correct bit position', () => {
        const modLevel = 42;
        const key = KeyUtils.getPackedKey(0, 0, modLevel);
        const extracted = (key >> KEY_SHIFT_LEVEL) & 0xFF;
        assert.strictEqual(extracted, modLevel);
    });

});

describe('KeyUtils.getStatsKey', () => {
    it('produces the same key for identical inputs', () => {
        const k1 = KeyUtils.getStatsKey(1, 2, 15);
        const k2 = KeyUtils.getStatsKey(1, 2, 15);
        assert.strictEqual(k1, k2);
    });

    it('produces different keys for different catId', () => {
        const k1 = KeyUtils.getStatsKey(0, 2, 15);
        const k2 = KeyUtils.getStatsKey(1, 2, 15);
        assert.notStrictEqual(k1, k2);
    });

    it('produces different keys for different matId', () => {
        const k1 = KeyUtils.getStatsKey(1, 0, 15);
        const k2 = KeyUtils.getStatsKey(1, 1, 15);
        assert.notStrictEqual(k1, k2);
    });

    it('produces different keys for different level', () => {
        const k1 = KeyUtils.getStatsKey(1, 2, 10);
        const k2 = KeyUtils.getStatsKey(1, 2, 20);
        assert.notStrictEqual(k1, k2);
    });

    it('produces the same key regardless of limit (cross-tier cache hit)', () => {
        // limit is NOT part of the stats key — ultra and coarse share a cache entry
        const kCoarse = KeyUtils.getStatsKey(1, 2, 15);
        const kUltra = KeyUtils.getStatsKey(1, 2, 15);
        assert.strictEqual(kCoarse, kUltra);
    });

});

// ── EnchantUtils ─────────────────────────────────────────────────────────────

describe('EnchantUtils.parse', () => {
    it('returns null for null input', () => {
        assert.strictEqual(EnchantUtils.parse(null, ROMAN_MAP), null);
    });

    it('parses "Sharpness IV" into {name:"Sharpness", rank:4}', () => {
        assert.deepStrictEqual(EnchantUtils.parse('Sharpness IV', ROMAN_MAP), { name: 'Sharpness', rank: 4 });
    });

    it('parses bare name "Sharpness" as rank 1', () => {
        assert.deepStrictEqual(EnchantUtils.parse('Sharpness', ROMAN_MAP), { name: 'Sharpness', rank: 1 });
    });

    it('parses multi-word name "Fire Aspect II"', () => {
        assert.deepStrictEqual(EnchantUtils.parse('Fire Aspect II', ROMAN_MAP), { name: 'Fire Aspect', rank: 2 });
    });

    it('treats unknown trailing word as part of name (rank 1)', () => {
        assert.deepStrictEqual(EnchantUtils.parse('Sharpness Max', ROMAN_MAP), { name: 'Sharpness Max', rank: 1 });
    });
});
