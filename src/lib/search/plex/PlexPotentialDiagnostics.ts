import type { SearchGraphExpansion } from '#lib/search/SearchGraph.js';
import type { SearchPool, SearchPoolEntry } from '#lib/search/registry/RegistryKernel.js';
import type { PackedEnchant } from '#types/index.js';
import {
    canonicalizePackedEnchantList,
    comparePackedEnchantLists,
    type CanonicalPackedEnchantList
} from '#lib/search/plex/PlexChoice.js';

export interface PlexGroupDiagnostic {
    readonly blocksBitset: bigint;
    readonly alternatives: CanonicalPackedEnchantList;
    readonly totalWeight: number;
}

export interface PlexPotentialDiagnostics {
    readonly eligibleEntryCount: number;
    readonly choiceGroupCount: number;
    readonly groupedEntryCount: number;
    readonly largestChoiceGroupSize: number;
    readonly choiceGroups: readonly PlexGroupDiagnostic[];
}

export function analyzePoolPlexPotential(pool: SearchPool): PlexPotentialDiagnostics {
    return analyzeEntriesPlexPotential(pool.entries);
}

export function analyzeExpansionPlexPotential(expansion: SearchGraphExpansion): PlexPotentialDiagnostics {
    return analyzeEntriesPlexPotential(expansion.edges.map(edge => edge.entry));
}

export function analyzeEntriesPlexPotential(
    entries: readonly SearchPoolEntry[]
): PlexPotentialDiagnostics {
    const groupsByBlocks = new Map<string, { blocksBitset: bigint; alternatives: PackedEnchant[]; totalWeight: number }>();

    for (const entry of entries) {
        const key = entry.blocksBitset.toString(16);
        let group = groupsByBlocks.get(key);
        if (!group) {
            group = { blocksBitset: entry.blocksBitset, alternatives: [], totalWeight: 0 };
            groupsByBlocks.set(key, group);
        }
        group.alternatives.push(entry.packedEnchant);
        group.totalWeight += entry.weight;
    }

    const choiceGroups = [...groupsByBlocks.values()]
        .filter(group => group.alternatives.length > 1)
        .map(group => Object.freeze({
            blocksBitset: group.blocksBitset,
            alternatives: canonicalizePackedEnchantList(group.alternatives),
            totalWeight: group.totalWeight
        }))
        .sort((a, b) => comparePackedEnchantLists(a.alternatives, b.alternatives));

    return Object.freeze({
        eligibleEntryCount: entries.length,
        choiceGroupCount: choiceGroups.length,
        groupedEntryCount: choiceGroups.reduce((sum, group) => sum + group.alternatives.length, 0),
        largestChoiceGroupSize: choiceGroups.reduce((largest, group) => Math.max(largest, group.alternatives.length), 0),
        choiceGroups: Object.freeze(choiceGroups)
    });
}
