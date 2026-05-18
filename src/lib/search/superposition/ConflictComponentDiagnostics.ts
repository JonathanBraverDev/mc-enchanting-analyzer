import type { SearchPool, SearchPoolEntry } from '#lib/search/registry/RegistryKernel.js';

export interface ConflictComponentDiagnostic {
    readonly id: number;
    readonly enchantIds: readonly number[];
    readonly entryCount: number;
}

export interface ConflictComponentInvariantDiagnostics {
    readonly componentCount: number;
    readonly largestComponentSize: number;
    readonly duplicateMembershipEnchantIds: readonly number[];
    readonly components: readonly ConflictComponentDiagnostic[];
}

/**
 * Builds conflict-component diagnostics from the active entries in one search pool.
 *
 * This is measurement-only setup for superposition search. Current registry rules
 * should make active conflict components disjoint; mutated registries can use the
 * duplicate-membership field as an invariant warning before enabling aggressive
 * choice-list assumptions.
 */
export function analyzePoolConflictComponents(pool: SearchPool): ConflictComponentInvariantDiagnostics {
    return analyzeConflictComponents(pool.entries);
}

export function analyzeConflictComponents(
    entries: readonly SearchPoolEntry[]
): ConflictComponentInvariantDiagnostics {
    const activeIds = new Set(entries.map(entry => entry.enchantId));
    const adjacency = new Map<number, Set<number>>();

    for (const entry of entries) {
        const neighbors = adjacency.get(entry.enchantId) ?? new Set<number>();
        adjacency.set(entry.enchantId, neighbors);

        for (const other of entries) {
            if (other.enchantId === entry.enchantId) continue;
            if ((entry.conflictBitset & other.idBit) === 0n) continue;
            if (!activeIds.has(other.enchantId)) continue;
            neighbors.add(other.enchantId);
            const reverse = adjacency.get(other.enchantId) ?? new Set<number>();
            reverse.add(entry.enchantId);
            adjacency.set(other.enchantId, reverse);
        }
    }

    const visited = new Set<number>();
    const membershipCounts = new Map<number, number>();
    const components: ConflictComponentDiagnostic[] = [];

    for (const id of [...adjacency.keys()].sort((a, b) => a - b)) {
        if (visited.has(id)) continue;
        const stack = [id];
        const component: number[] = [];
        visited.add(id);

        while (stack.length > 0) {
            const current = stack.pop()!;
            component.push(current);
            membershipCounts.set(current, (membershipCounts.get(current) ?? 0) + 1);

            for (const next of adjacency.get(current) ?? []) {
                if (visited.has(next)) continue;
                visited.add(next);
                stack.push(next);
            }
        }

        if (component.length <= 1) continue;
        component.sort((a, b) => a - b);
        components.push(Object.freeze({
            id: components.length,
            enchantIds: Object.freeze(component),
            entryCount: entries.filter(entry => component.includes(entry.enchantId)).length
        }));
    }

    const duplicateMembershipEnchantIds = [...membershipCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([id]) => id)
        .sort((a, b) => a - b);

    return Object.freeze({
        componentCount: components.length,
        largestComponentSize: components.reduce((largest, component) => Math.max(largest, component.enchantIds.length), 0),
        duplicateMembershipEnchantIds: Object.freeze(duplicateMembershipEnchantIds),
        components: Object.freeze(components)
    });
}
