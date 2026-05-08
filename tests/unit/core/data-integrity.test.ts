/**
 * Data-integrity tests.
 *
 * Validates the static data files (enchantments, groups, versions) and
 * verifies invariants that must hold after RegistryFactory.build():
 *
 *   - Every enchantment has required fields with sensible values
 *   - Level ranges are valid (min ≥ 1, min < max)
 *   - Every conflict rule resolves to known enchantments and version boundaries
 *   - Every enchantment-group rule member is a known enchantment
 *   - Conflict pairs are symmetric after factory expansion
 *     (if A conflicts with B then B must conflict with A)
 *
 * These tests catch bugs that would silently corrupt results and are
 * unlikely to be caught by the engine/integration test suite.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { global_enchantments } from '#data/enchantments.js';
import { conflict_rules, enchantment_group_rules, enchantable_item_rules, material_rules, material_sets } from '#data/registry-rules.js';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { hasConflict, getEnchantId, getEnchantability } from '#core/registry.js';
import { versions } from '#data/versions.js';
import { material_values } from '#data/materials.js';
import { VersionUtils } from '#utils/index.js';
import { getRegistryVersionBoundaries } from '#core/version-resolution.js';
import type { EnchantmentData } from '#types/index.js';

const registryEnchantments: EnchantmentData["global_enchantments"] = global_enchantments;
const registryVersions: EnchantmentData["versions"] = versions;
const registryConflictRules: EnchantmentData["conflict_rules"] = conflict_rules;
const registryGroupRules: EnchantmentData["enchantment_group_rules"] = enchantment_group_rules;
const registryItemRules: EnchantmentData["enchantable_item_rules"] = enchantable_item_rules;
const registryMaterialRules: EnchantmentData["material_rules"] = material_rules;
const registryMaterialSets: EnchantmentData["material_sets"] = material_sets;
const enchantNames = Object.keys(registryEnchantments);
const versionEntries = Object.entries(registryVersions);
const supportedVersions = getRegistryVersionBoundaries(DATA);

function collectVersionMaterials(version: string): Set<string> {
    const materials = new Set<string>();
    for (const rule of registryMaterialRules) {
        if (isTimelineEntryActive(version, rule.valid_from, rule.valid_until)) materials.add(rule.material);
    }
    return materials;
}

function isTimelineEntryActive(version: string, validFrom: string, validUntil?: string): boolean {
    if (VersionUtils.compare(version, validFrom) < 0) return false;
    return validUntil === undefined || VersionUtils.compare(version, validUntil) < 0;
}

// ── Enchantment required fields ───────────────────────────────────────────────

describe('Data integrity: enchantment required fields', () => {
    it('all enchantments have a weight >= 1', () => {
        const bad: string[] = [];
        for (const [name, ench] of Object.entries(registryEnchantments)) {
            if (typeof ench.weight !== 'number' || ench.weight < 1) bad.push(name);
        }
        assert.deepStrictEqual(bad, [], `enchantments with invalid weight: ${bad.join(', ')}`);
    });

    it('all enchantments have at least one level entry', () => {
        const bad: string[] = [];
        for (const [name, ench] of Object.entries(registryEnchantments)) {
            if (!ench.levels || Object.keys(ench.levels).length === 0) bad.push(name);
        }
        assert.deepStrictEqual(bad, [], `enchantments with no levels: ${bad.join(', ')}`);
    });

    it('all enchantments have a valid_from string', () => {
        const bad: string[] = [];
        for (const [name, ench] of Object.entries(registryEnchantments)) {
            if (typeof ench.valid_from !== 'string') bad.push(name);
        }
        assert.deepStrictEqual(bad, [], `enchantments missing valid_from: ${bad.join(', ')}`);
    });

    it('all enchantment availability boundaries are selectable registry versions', () => {
        const versionKeys = new Set(supportedVersions);
        const missing = Object.entries(registryEnchantments).flatMap(([name, ench]) => {
            const bad: string[] = [];
            if (!versionKeys.has(ench.valid_from ?? '')) bad.push(`${name} valid_from: ${ench.valid_from}`);
            if (ench.valid_to && !versionKeys.has(ench.valid_to)) bad.push(`${name} valid_to: ${ench.valid_to}`);
            return bad;
        });

        assert.deepStrictEqual(missing, [], `enchantment versions missing from versions manifest: ${missing.join(', ')}`);
    });
});

// ── Level range validity ───────────────────────────────────────────────────────

describe('Data integrity: level ranges', () => {
    it('all level ranges have min >= 1', () => {
        const bad: string[] = [];
        for (const [name, ench] of Object.entries(registryEnchantments)) {
            for (const [roman, range] of Object.entries(ench.levels)) {
                if (range[0] < 1) bad.push(`${name} ${roman}: min=${range[0]}`);
            }
        }
        assert.deepStrictEqual(bad, [], `level ranges with min < 1: ${bad.join('; ')}`);
    });

    it('all level ranges have min strictly less than max', () => {
        const bad: string[] = [];
        for (const [name, ench] of Object.entries(registryEnchantments)) {
            for (const [roman, range] of Object.entries(ench.levels)) {
                const key = `${name} ${roman}`;
                if (range[0] >= range[1]) {
                    bad.push(`${key}: [${range[0]}, ${range[1]}]`);
                }
            }
        }
        assert.deepStrictEqual(bad, [], `level ranges where min >= max: ${bad.join('; ')}`);
    });
});

describe('Data integrity: latest vanilla 1.21.11 spot checks', () => {
    const engine = EngineFactory.create(DATA, '1.21.11');
    const reg = engine.registry;

    it('Lunge uses vanilla 1.21.11 costs and remains table-book eligible', () => {
        assert.deepStrictEqual(global_enchantments.Lunge.levels, {
            I: [5, 25],
            II: [13, 33],
            III: [21, 41]
        });
        assert.ok(reg.itemPoolByVersion.get('book')?.includes('Lunge'), 'Lunge should be in the book pool');
    });

    it('treasure-only enchantments are not active table registry entries', () => {
        assert.ok(!('Frost Walker' in global_enchantments), 'Frost Walker should not be in the active table registry');
        assert.ok(!reg.itemPoolByVersion.get('book')?.includes('Frost Walker'), 'Frost Walker should be excluded from the book pool');
    });

    it('omits vanilla empty rank ranges that cannot be rolled by the table', () => {
        assert.deepStrictEqual(global_enchantments['Quick Charge'].levels, {
            I: [12, 50],
            II: [32, 50]
        });
        assert.ok(!Object.hasOwn(global_enchantments['Quick Charge'].levels, 'III'), 'Quick Charge III is vanilla 52-50 and cannot be rolled');
    });

    it('omits Thorns III because its vanilla range starts above reachable table rolls', () => {
        assert.deepStrictEqual(global_enchantments.Thorns.levels, {
            I: [10, 60],
            II: [30, 80]
        });
        assert.ok(!Object.hasOwn(global_enchantments.Thorns.levels, 'III'), 'Thorns III starts at modified level 50 and cannot be rolled directly');
    });

    it('Impaling participates in the 1.21.11 damage exclusive set', () => {
        const damageNames = ['Sharpness', 'Smite', 'Bane of Arthropods', 'Density', 'Breach'];
        const impalingId = getEnchantId(reg, 'Impaling');

        for (const name of damageNames) {
            const id = getEnchantId(reg, name);
            assert.ok(hasConflict(reg, impalingId, id), `Impaling should conflict with ${name}`);
            assert.ok(hasConflict(reg, id, impalingId), `${name} should conflict with Impaling`);
        }
    });
});

// ── Conflict rule validity ─────────────────────────────────────────────────────

describe('Data integrity: conflict rules resolve to known data', () => {
    it('enchantment entries do not declare inline conflicts', () => {
        const inlineConflicts: string[] = [];
        for (const [name, ench] of Object.entries(registryEnchantments)) {
            if ('conflicts' in ench) inlineConflicts.push(name);
        }

        assert.deepStrictEqual(inlineConflicts, [], `enchantments with inline conflicts: ${inlineConflicts.join(', ')}`);
    });

    it('all conflict rules reference two known, distinct enchantments', () => {
        const badRules: string[] = [];
        for (const rule of registryConflictRules) {
            const [left, right] = rule.enchants;
            if (left === right || !enchantNames.includes(left) || !enchantNames.includes(right)) {
                badRules.push(`${left} ↔ ${right}`);
            }
        }

        assert.deepStrictEqual(
            badRules, [],
            `invalid conflict rules: ${badRules.join(', ')}`
        );
    });

    it('does not duplicate conflict rules for the same pair and version range', () => {
        const seen = new Set<string>();
        const duplicates: string[] = [];

        for (const rule of registryConflictRules) {
            const pair = [...rule.enchants].sort().join('|');
            const validUntil = 'valid_until' in rule ? rule.valid_until : '';
            const key = `${pair}|${rule.valid_from}|${validUntil}`;
            if (seen.has(key)) duplicates.push(key);
            seen.add(key);
        }

        assert.deepStrictEqual(duplicates, [], `duplicate conflict rules: ${duplicates.join(', ')}`);
    });
});

// ── Enchantment group membership ───────────────────────────────────────────────

describe('Data integrity: enchantment group rules reference valid enchantments', () => {
    it('all members of every enchantment group rule are known enchantments', () => {
        const unknown: string[] = [];
        for (const rule of registryGroupRules) {
            for (const member of rule.enchantments) {
                if (!enchantNames.includes(member)) {
                    unknown.push(`group "${rule.group}" → "${member}"`);
                }
            }
        }
        assert.deepStrictEqual(
            unknown, [],
            `enchantment group rules with unknown members: ${unknown.join(', ')}`
        );
    });

    it('all enchantment group rules have at least one member', () => {
        const empty = registryGroupRules
            .filter(rule => rule.enchantments.length === 0)
            .map(rule => rule.group);

        assert.deepStrictEqual(empty, [], `empty enchantment group rules: ${empty.join(', ')}`);
    });
});

// ── Conflict symmetry after factory build ─────────────────────────────────────

describe('Data integrity: version manifests reference known data', () => {
    it('all parent versions exist and inheritance chains are acyclic', () => {
        const missingParents: string[] = [];
        const cycles: string[] = [];

        for (const [version, manifest] of versionEntries) {
            if (manifest.extends && !registryVersions[manifest.extends]) {
                missingParents.push(`${version} extends ${manifest.extends}`);
                continue;
            }

            const seen = new Set<string>();
            let current: string | undefined = version;
            while (current) {
                if (seen.has(current)) {
                    cycles.push(`${version} cycles at ${current}`);
                    break;
                }
                seen.add(current);
                current = registryVersions[current]?.extends;
            }
        }

        assert.deepStrictEqual(missingParents, [], `missing version parents: ${missingParents.join(', ')}`);
        assert.deepStrictEqual(cycles, [], `cyclic version inheritance: ${cycles.join(', ')}`);
    });

    it('all version overrides reference known enchantments', () => {
        const unknown: string[] = [];
        for (const [version, manifest] of versionEntries) {
            for (const enchantment of Object.keys(manifest.overrides ?? {})) {
                if (!enchantNames.includes(enchantment)) unknown.push(`${version}: ${enchantment}`);
            }
        }

        assert.deepStrictEqual(unknown, [], `version overrides for unknown enchantments: ${unknown.join(', ')}`);
    });
});

describe('Data integrity: registry rules reference known data', () => {
    it('all registry rule boundaries are selectable registry versions', () => {
        const versionKeys = new Set(supportedVersions);
        const missing = [
            ...registryConflictRules.flatMap(rule => {
                const bad: string[] = [];
                if (!versionKeys.has(rule.valid_from)) bad.push(`${rule.enchants.join(' ↔ ')} valid_from: ${rule.valid_from}`);
                if (rule.valid_until && !versionKeys.has(rule.valid_until)) bad.push(`${rule.enchants.join(' ↔ ')} valid_until: ${rule.valid_until}`);
                return bad;
            }),
            ...registryGroupRules.flatMap(rule => {
                const bad: string[] = [];
                if (!versionKeys.has(rule.valid_from)) bad.push(`${rule.group} valid_from: ${rule.valid_from}`);
                if (rule.valid_until && !versionKeys.has(rule.valid_until)) bad.push(`${rule.group} valid_until: ${rule.valid_until}`);
                return bad;
            }),
            ...registryItemRules.flatMap(rule => {
                const bad: string[] = [];
                if (!versionKeys.has(rule.valid_from)) bad.push(`${rule.item} valid_from: ${rule.valid_from}`);
                if (rule.valid_until && !versionKeys.has(rule.valid_until)) bad.push(`${rule.item} valid_until: ${rule.valid_until}`);
                return bad;
            }),
            ...registryMaterialRules.flatMap(rule => {
                const bad: string[] = [];
                if (!versionKeys.has(rule.valid_from)) bad.push(`${rule.material} valid_from: ${rule.valid_from}`);
                if (rule.valid_until && !versionKeys.has(rule.valid_until)) bad.push(`${rule.material} valid_until: ${rule.valid_until}`);
                return bad;
            })
        ];

        assert.deepStrictEqual(missing, [], `registry rule versions missing from versions manifest: ${missing.join(', ')}`);
    });

    it('enchantable item rules reference known groups or enchantments', () => {
        const groupNames = new Set(registryGroupRules.map(rule => rule.group));
        const unknown: string[] = [];

        for (const rule of registryItemRules) {
            for (const entry of rule.groups ?? []) {
                if (!groupNames.has(entry) && !enchantNames.includes(entry)) {
                    unknown.push(`${rule.item}: ${entry}`);
                }
            }
        }

        assert.deepStrictEqual(unknown, [], `enchantable item rules with unknown entries: ${unknown.join(', ')}`);
    });

    it('only book item rules may omit groups, and explicit groups are never empty', () => {
        const invalidDerived: string[] = [];
        const emptyGroups: string[] = [];

        for (const rule of registryItemRules) {
            if (rule.groups === undefined && rule.item !== 'book') invalidDerived.push(rule.item);
            if (rule.groups !== undefined && rule.groups.length === 0) emptyGroups.push(rule.item);
        }

        assert.deepStrictEqual(invalidDerived, [], `non-book derived item pools: ${invalidDerived.join(', ')}`);
        assert.deepStrictEqual(emptyGroups, [], `item rules with empty groups: ${emptyGroups.join(', ')}`);

        const latestBookPool = EngineFactory.create(DATA, '1.21.11').registry.itemPoolByVersion.get('book') ?? [];
        assert.deepStrictEqual([...latestBookPool].sort(), [...enchantNames].sort());
    });

    it('enchantable item rules do not overlap for the same selectable version', () => {
        const overlaps: string[] = [];
        for (const item of new Set(registryItemRules.map(rule => rule.item))) {
            for (const version of supportedVersions) {
                const active = registryItemRules.filter(rule =>
                    rule.item === item && isTimelineEntryActive(version, rule.valid_from, rule.valid_until)
                );
                if (active.length > 1) overlaps.push(`${item}@${version}`);
            }
        }

        assert.deepStrictEqual(overlaps, [], `overlapping item rules: ${overlaps.join(', ')}`);
    });

    it('all derived registry versions can be built', () => {
        const failures: string[] = [];
        for (const version of supportedVersions) {
            try {
                EngineFactory.create(DATA, version);
            } catch (error: any) {
                failures.push(`${version}: ${error?.message ?? String(error)}`);
            }
        }

        assert.deepStrictEqual(failures, [], `derived versions that failed to build: ${failures.join('; ')}`);
    });

    it('material rules reference known material entries', () => {
        const toolMats = new Set(Object.keys(material_values.tools));
        const armorMats = new Set(Object.keys(material_values.armor));
        const missing = registryMaterialRules
            .map(rule => rule.material)
            .filter(material => !toolMats.has(material) && !armorMats.has(material));

        assert.deepStrictEqual(missing, [], `material rules with unknown materials: ${missing.join(', ')}`);
    });

    it('enchantable item rule materials reference known material aliases or material entries', () => {
        const materialAliases = new Set(Object.keys(registryMaterialSets));
        const toolMats = new Set(Object.keys(material_values.tools));
        const armorMats = new Set(Object.keys(material_values.armor));
        const unknown: string[] = [];

        for (const rule of registryItemRules) {
            if (rule.materials.length === 0) unknown.push(`${rule.item}: empty materials`);
            for (const material of rule.materials) {
                if (!materialAliases.has(material) && !toolMats.has(material) && !armorMats.has(material)) {
                    unknown.push(`${rule.item}/${material}`);
                }
            }
        }

        assert.deepStrictEqual(unknown, [], `item rule materials with unknown entries: ${unknown.join(', ')}`);
    });

    it('material aliases reference known material entries', () => {
        const toolMats = new Set(Object.keys(material_values.tools));
        const armorMats = new Set(Object.keys(material_values.armor));
        const unknown: string[] = [];

        for (const [set, materials] of Object.entries(registryMaterialSets)) {
            if (materials.length === 0) unknown.push(`${set}: empty materials`);
            for (const material of materials) {
                if (!toolMats.has(material) && !armorMats.has(material)) {
                    unknown.push(`${set}/${material}`);
                }
            }
        }

        assert.deepStrictEqual(unknown, [], `material aliases with unknown entries: ${unknown.join(', ')}`);
    });
});

describe('Data integrity: conflict symmetry after RegistryFactory.build()', () => {
    // Build with the latest version so all enchantments are active
    const engine = EngineFactory.create(DATA, '1.21.11');
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

    // Spot-check specific pairs that are compiled from unordered conflict rules.
    it('Fortune ↔ Silk Touch conflict is symmetric', () => {
        const fortuneId = getEnchantId(reg, 'Fortune');
        const silkId    = getEnchantId(reg, 'Silk Touch');
        assert.ok(hasConflict(reg, fortuneId, silkId), 'Fortune should conflict with Silk Touch');
        assert.ok(hasConflict(reg, silkId, fortuneId), 'Silk Touch should conflict with Fortune');
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

describe('Data integrity: conflict bitsets only include active version enchantments', () => {
    it('older damage enchantments do not conflict with future damage enchantments before those enchants exist', () => {
        const v18 = EngineFactory.create(DATA, '1.8').registry;
        const sharpnessId = getEnchantId(v18, 'Sharpness');
        const impalingId = getEnchantId(v18, 'Impaling');
        const densityId = getEnchantId(v18, 'Density');
        const breachId = getEnchantId(v18, 'Breach');

        assert.ok(!hasConflict(v18, sharpnessId, impalingId), '1.8 Sharpness should not conflict with future Impaling');
        assert.ok(!hasConflict(v18, impalingId, sharpnessId), '1.8 inactive Impaling should not conflict with Sharpness');
        assert.ok(!hasConflict(v18, sharpnessId, densityId), '1.8 Sharpness should not conflict with future Density');
        assert.ok(!hasConflict(v18, sharpnessId, breachId), '1.8 Sharpness should not conflict with future Breach');
    });

    it('conflicts activate as the relevant enchantments enter the table registry', () => {
        const v13 = EngineFactory.create(DATA, '1.13').registry;
        const sharpnessId = getEnchantId(v13, 'Sharpness');
        const impalingId = getEnchantId(v13, 'Impaling');
        const densityId = getEnchantId(v13, 'Density');

        assert.ok(hasConflict(v13, sharpnessId, impalingId), '1.13 Sharpness should conflict with Impaling');
        assert.ok(hasConflict(v13, impalingId, sharpnessId), '1.13 Impaling should conflict with Sharpness');
        assert.ok(!hasConflict(v13, sharpnessId, densityId), '1.13 Sharpness should not conflict with future Density');
    });
});

// ── Material coverage ─────────────────────────────────────────────────────────

describe('Data integrity: material enchantability coverage', () => {
    it('every material rule has an enchantability entry', () => {
        const allMaterials = new Set<string>();
        for (const rule of registryMaterialRules) allMaterials.add(rule.material);

        const toolMats  = new Set(Object.keys(material_values.tools));
        const armorMats = new Set(Object.keys(material_values.armor));

        const missing: string[] = [];
        for (const material of allMaterials) {
            if (!toolMats.has(material) && !armorMats.has(material)) {
                missing.push(material);
            }
        }

        assert.deepStrictEqual(
            missing, [],
            `Materials missing enchantability entry: ${missing.join(', ')}`
        );
    });

    it('every category+material in the latest version resolves enchantability without throwing', () => {
        const latestVersion = '1.21.11';
        const engine = EngineFactory.create(DATA, latestVersion);
        const reg = engine.registry;
        const items = [...reg.itemPoolByVersion.keys()];
        const armorCats = DATA.constants.ARMOR_CATS as readonly string[];
        const bad: string[] = [];

        const validMaterials = collectVersionMaterials(latestVersion);

        for (const item of items) {
            // Only test materials that make sense for this category type
            const candidateMats = item === 'book' ? ['book']
                : armorCats.includes(item) ? [...validMaterials].filter(m => m in material_values.armor)
                : [...validMaterials].filter(m => m in material_values.tools);

            for (const material of candidateMats) {
                try {
                    getEnchantability(reg, material, item);
                } catch (e: any) {
                    bad.push(`${item}/${material}: ${e.message}`);
                }
            }
        }

        assert.deepStrictEqual(bad, [], `Enchantability lookup failures:\n${bad.join('\n')}`);
    });
});
