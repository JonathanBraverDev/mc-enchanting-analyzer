import type { EnchantmentData } from '#types/index.js';
import { VersionUtils } from '#utils/index.js';
import { getKnownRegistryBoundaries } from '#core/availability.js';

export function getRegistryVersionBoundaries(data: EnchantmentData): string[] {
    return getKnownRegistryBoundaries(data);
}

export function resolveRegistryVersion(data: EnchantmentData, version: string): string {
    return resolveFromSorted(getRegistryVersionBoundaries(data), version);
}

export function resolveManifestVersion(data: EnchantmentData, version: string): string {
    return resolveFromSorted(Object.keys(data.versions).sort(VersionUtils.compare), version);
}

function resolveFromSorted(sortedVersions: string[], version: string): string {
    let resolved = sortedVersions[0] ?? version;
    for (const candidate of sortedVersions) {
        if (VersionUtils.compare(version, candidate) >= 0) resolved = candidate;
    }
    return resolved;
}
