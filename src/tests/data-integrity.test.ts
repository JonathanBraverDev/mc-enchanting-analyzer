/**
 * Data-integrity tests.
 *
 * Validates the static data files (enchantments, groups, versions) and
 * verifies invariants that must hold after RegistryFactory.build():
 *
 *   - Every enchantment has required fields with sensible values
 *   - Level ranges are valid (min ≥ 1, min < max)
 *   - Every conflict name resolves to a known enchantment
 *   - Every enchantment-group member is a known enchantment
 *   - Conflict pairs are symmetric after factory expansion
 *     (if A conflicts with B then B must conflict with A)
 *
 * These tests catch bugs that would silently corrupt results and are
 * unlikely to be caught by the engine/integration test suite.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { global_enchantments, enchantment_groups } from '../data/enchantments.js';
import { EnchantEngine } from '../engine/index.js';
import { DATA } from '../data/index.js';
import { hasConflict, getEnchantId } from '../core/registry.js';

const enchantNames = Object.keys(global_enchantments);

// ── Enchantment required fields ───────────────────────────────────────────────

describe('Data integrity: enchantment required fields', () => {
    it('all enchantments have a weight >= 1', () => {
        const bad: string[] = [];
        for (const [name, ench] of Object.entries(global_enchantments)) {
            if (typeof ench.weight !== 'number' || ench.weight < 1) bad.push(name);
        }
        assert.deepStrictEqual(bad, [], `enchantments with invalid weight: ${bad.join(', ')}`);
    });

    it('all enchantments have at least one level entry', () => {
        const bad: string[] = [];
        for (const [name, ench] of Object.entries(global_enchantments)) {
            if (!ench.levels || Object.keys(ench.levels).length === 0) bad.push(name);
        }
        assert.deepStrictEqual(bad, [], `enchantments with no levels: ${bad.join(', ')}`);
    });

    it('all enchantments have a valid_from string', () => {
        const bad: string[] = [];
        for (const [name, ench] of Object.entries(global_enchantments)) {
            if (typeof (ench as any).valid_from !== 'string') bad.push(name);
        }
        assert.deepStrictEqual(bad, [], `enchantments missing valid_from: ${bad.join(', ')}`);
    });
});

// ── Level range validity ───────────────────────────────────────────────────────

describe('Data integrity: level ranges', () => {
    it('all level ranges have min >= 1', () => {
        const bad: string[] = [];
        for (const [name, ench] of Object.entries(global_enchantments)) {
            for (const [roman, range] of Object.entries(ench.levels)) {
                if (range[0] < 1) bad.push(`${name} ${roman}: min=${range[0]}`);
            }
        }
        assert.deepStrictEqual(bad, [], `level ranges with min < 1: ${bad.join('; ')}`);
    });

    it('all level ranges have min strictly less than max', () => {
        const bad: string[] = [];
        for (const [name, ench] of Object.entries(global_enchantments)) {
            for (const [roman, range] of Object.entries(ench.levels)) {
                if (range[0] >= range[1]) bad.push(`${name} ${roman}: [${range[0]}, ${range[1]}]`);
            }
        }
        assert.deepStrictEqual(bad, [], `level ranges where min >= max: ${bad.join('; ')}`);
    });
});

// ── Conflict name validity ─────────────────────────────────────────────────────

describe('Data integrity: conflict names resolve to known enchantments', () => {
    it('all declared conflict names are valid enchantment names', () => {
        const unknownConflicts: string[] = [];
        for (const [name, ench] of Object.entries(global_enchantments)) {
            const conflicts = (ench as any).conflicts ?? [];
            for (const conflictName of conflicts) {
                if (!enchantNames.includes(conflictName)) {
                    unknownConflicts.push(`"${name}" → "${conflictName}"`);
                }
            }
        }
        assert.deepStrictEqual(
            unknownConflicts, [],
            `unresolvable conflict references: ${unknownConflicts.join(', ')}`
        );
    });
});

// ── Enchantment group membership ───────────────────────────────────────────────

describe('Data integrity: enchantment groups reference valid enchantments', () => {
    it('all members of every enchantment group are known enchantments', () => {
        const unknown: string[] = [];
        for (const [groupName, members] of Object.entries(enchantment_groups)) {
            for (const member of members) {
                if (!enchantNames.includes(member)) {
                    unknown.push(`group "${groupName}" → "${member}"`);
                }
            }
        }
        assert.deepStrictEqual(
            unknown, [],
            `enchantment groups with unknown members: ${unknown.join(', ')}`
        );
    });
});

// ── Conflict symmetry after factory build ─────────────────────────────────────

describe('Data integrity: conflict symmetry after RegistryFactory.build()', () => {
    // Build with the latest version so all enchantments are active
    const engine = new EnchantEngine(DATA, '1.21.11');
    const reg    = engine.registry;

    it('all conflict pairs are symmetric (exhaustive check)', () => {
        const allNames = reg.revIdMap;
        const asymmetric: string[] = [];
        for (let i = 0; i < allNames.length; i++) {
            for (let j = i + 1; j < allNames.length; j++) {
                const aConflictsB = hasConflict(reg, i, j);
                const bConflictsA = hasConflict(reg, j, i);
                if (aConflictsB !== bConflictsA) {
                    asymmetric.push(`${allNames[i]} ↔ ${allNames[j]}`);
                }
            }
        }
        assert.deepStrictEqual(
            asymmetric, [],
            `asymmetric conflict pairs: ${asymmetric.join(', ')}`
        );
    });

    // Spot-check specific pairs that are defined one-directionally in the raw data
    it('Fortune ↔ Silk Touch conflict is symmetric', () => {
        const fortuneId = getEnchantId(reg, 'Fortune');
        const silkId    = getEnchantId(reg, 'Silk Touch');
        assert.ok(hasConflict(reg, fortuneId, silkId), 'Fortune should conflict with Silk Touch');
        assert.ok(hasConflict(reg, silkId, fortuneId), 'Silk Touch should conflict with Fortune');
    });

    it('Depth Strider ↔ Frost Walker conflict is symmetric', () => {
        const depthId = getEnchantId(reg, 'Depth Strider');
        const frostId = getEnchantId(reg, 'Frost Walker');
        assert.ok(hasConflict(reg, depthId, frostId));
        assert.ok(hasConflict(reg, frostId, depthId));
    });

    it('Multishot ↔ Piercing conflict is symmetric', () => {
        const multishotId = getEnchantId(reg, 'Multishot');
        const piercingId  = getEnchantId(reg, 'Piercing');
        assert.ok(hasConflict(reg, multishotId, piercingId));
        assert.ok(hasConflict(reg, piercingId, multishotId));
    });

    it('Riptide ↔ Loyalty conflict is symmetric', () => {
        const riptideId = getEnchantId(reg, 'Riptide');
        const loyaltyId = getEnchantId(reg, 'Loyalty');
        assert.ok(hasConflict(reg, riptideId, loyaltyId));
        assert.ok(hasConflict(reg, loyaltyId, riptideId));
    });

    it('Riptide ↔ Channeling conflict is symmetric', () => {
        const riptideId    = getEnchantId(reg, 'Riptide');
        const channelingId = getEnchantId(reg, 'Channeling');
        assert.ok(hasConflict(reg, riptideId, channelingId));
        assert.ok(hasConflict(reg, channelingId, riptideId));
    });

    it('Density ↔ Breach conflict is symmetric', () => {
        const densityId = getEnchantId(reg, 'Density');
        const breachId  = getEnchantId(reg, 'Breach');
        assert.ok(hasConflict(reg, densityId, breachId));
        assert.ok(hasConflict(reg, breachId, densityId));
    });

    it('non-conflicting enchants show no conflict in either direction', () => {
        // Efficiency and Unbreaking have no declared conflict
        const effId  = getEnchantId(reg, 'Efficiency');
        const unbrId = getEnchantId(reg, 'Unbreaking');
        assert.ok(!hasConflict(reg, effId,  unbrId), 'Efficiency should not conflict with Unbreaking');
        assert.ok(!hasConflict(reg, unbrId, effId),  'Unbreaking should not conflict with Efficiency');
    });
});
