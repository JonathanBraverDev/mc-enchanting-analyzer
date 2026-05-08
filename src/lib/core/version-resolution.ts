import type { EnchantmentData } from '#types/index.js';
import { VersionUtils } from '#utils/index.js';

export function getRegistryVersionBoundaries(data: EnchantmentData): string[] {
    const versions = new Set(Object.keys(data.versions));

    for (const enchantment of Object.values(data.global_enchantments)) {
        if (enchantment.valid_from) versions.add(enchantment.valid_from);
        if (enchantment.valid_to) versions.add(enchantment.valid_to);
    }

    for (const rule of data.conflict_rules) addRuleBoundaries(versions, rule);
    for (const rule of data.enchantment_group_rules) addRuleBoundaries(versions, rule);
    for (const rule of data.enchantable_item_rules) addRuleBoundaries(versions, rule);
    for (const rule of data.material_rules) addRuleBoundaries(versions, rule);

    return [...versions].sort(VersionUtils.compare);
}

export function resolveRegistryVersion(data: EnchantmentData, version: string): string {
    return resolveFromSorted(getRegistryVersionBoundaries(data), version);
}

export function resolveManifestVersion(data: EnchantmentData, version: string): string {
    return resolveFromSorted(Object.keys(data.versions).sort(VersionUtils.compare), version);
}

function addRuleBoundaries(versions: Set<string>, rule: { valid_from: string; valid_until?: string | undefined }): void {
    versions.add(rule.valid_from);
    if (rule.valid_until) versions.add(rule.valid_until);
}

function resolveFromSorted(sortedVersions: string[], version: string): string {
    let resolved = sortedVersions[0] ?? version;
    for (const candidate of sortedVersions) {
        if (VersionUtils.compare(version, candidate) >= 0) resolved = candidate;
    }
    return resolved;
}
