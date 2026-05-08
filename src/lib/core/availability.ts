import type { EnchantmentData } from '#types/index.js';
import { VersionUtils } from '#utils/index.js';

export interface RegistryAvailability {
    valid_from?: string | undefined;
    valid_until?: string | undefined;
}

export function getKnownRegistryBoundaries(data: EnchantmentData): string[] {
    const versions = new Set(Object.keys(data.versions));

    for (const { entry } of getRegistryAvailabilityEntries(data)) {
        if (entry.valid_from) versions.add(entry.valid_from);
        if (entry.valid_until) versions.add(entry.valid_until);
    }

    return [...versions].sort(VersionUtils.compare);
}

export function isAvailabilityActive(
    version: string,
    entry: RegistryAvailability
): boolean {
    if (entry.valid_from && VersionUtils.compare(version, entry.valid_from) < 0) return false;
    return entry.valid_until === undefined || VersionUtils.compare(version, entry.valid_until) < 0;
}

function getRegistryAvailabilityEntries(data: EnchantmentData): { entry: RegistryAvailability; context: string }[] {
    return [
        ...Object.entries(data.global_enchantments).map(([name, entry]) => ({
            entry,
            context: `enchantment "${name}"`
        })),
        ...data.conflict_rules.map(rule => ({
            entry: rule,
            context: `conflict rule "${rule.enchants.join(' <-> ')}"`
        })),
        ...data.enchantment_group_rules.map(rule => ({
            entry: rule,
            context: `enchantment group rule "${rule.group}"`
        })),
        ...data.enchantable_item_rules.map(rule => ({
            entry: rule,
            context: `enchantable item rule "${rule.item}"`
        })),
        ...data.material_rules.map(rule => ({
            entry: rule,
            context: `material rule "${rule.material}"`
        }))
    ];
}
