import type { EnchantmentData } from '#types/index.js';
import { VersionUtils } from '#utils/index.js';

export interface RegistryAvailability {
    valid_from?: string | undefined;
    valid_until?: string | undefined;
    /** @deprecated V6_REMOVE: Legacy enchantment custom data only; use exclusive valid_until. */
    valid_to?: string | undefined;
}

export interface NormalizedRegistryAvailability {
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

export function assertRegistryAvailability(data: EnchantmentData, boundaries = getKnownRegistryBoundaries(data)): void {
    for (const { entry, context } of getRegistryAvailabilityEntries(data)) {
        normalizeAvailability(entry, boundaries, context);
    }
}

export function normalizeAvailability(
    entry: RegistryAvailability,
    boundaries: readonly string[],
    context = 'registry entry'
): NormalizedRegistryAvailability {
    if (entry.valid_to !== undefined && entry.valid_until !== undefined) {
        throw new Error(`${context} cannot define both valid_to and valid_until; valid_to is deprecated, use valid_until.`);
    }

    if (entry.valid_to === undefined) {
        return {
            valid_from: entry.valid_from,
            valid_until: entry.valid_until
        };
    }

    const validUntil = findNextBoundary(boundaries, entry.valid_to);
    if (validUntil === undefined) {
        throw new Error(`${context} valid_to is deprecated and cannot be converted; use valid_until.`);
    }

    return {
        valid_from: entry.valid_from,
        valid_until: validUntil
    };
}

export function isAvailabilityActive(
    version: string,
    entry: RegistryAvailability,
    boundaries: readonly string[],
    context = 'registry entry'
): boolean {
    const normalized = normalizeAvailability(entry, boundaries, context);
    if (normalized.valid_from && VersionUtils.compare(version, normalized.valid_from) < 0) return false;
    return normalized.valid_until === undefined || VersionUtils.compare(version, normalized.valid_until) < 0;
}

function findNextBoundary(boundaries: readonly string[], validTo: string): string | undefined {
    for (const boundary of boundaries) {
        if (VersionUtils.compare(boundary, validTo) > 0) return boundary;
    }
    return undefined;
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
