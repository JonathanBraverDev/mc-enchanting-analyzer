import type { SearchPool, SearchPoolFamilySignature } from '#lib/search/registry/RegistryKernel.js';

export type SearchExpansionFutureSignature = string & { readonly __brand: 'SearchExpansionFutureSignature' };

export interface SearchExpansionBlueprint {
    readonly eligibleEntryIndexes: readonly number[];
    readonly totalWeight: number;
}

export interface SearchExpansionBlueprintLookup {
    readonly blueprint: SearchExpansionBlueprint;
    readonly futureSignature: SearchExpansionFutureSignature;
    readonly hit: boolean;
    readonly candidateChecks: number;
}

/**
 * Reusable candidate-filter templates for structurally equivalent search pools.
 *
 * The cache deliberately stores exact-pool entry indexes, not child node IDs or
 * combo data. Each SearchGraph still materializes edges against its own exact
 * pool so rank/combo payloads and node identity remain graph-local.
 */
export class SearchExpansionBlueprintCache {
    private readonly cache = new Map<string, SearchExpansionBlueprint>();

    public getOrCreate(
        pool: SearchPool,
        selectedMask: bigint,
        currentLevel: number,
        count: number
    ): SearchExpansionBlueprintLookup {
        const key = this.createKey(pool.familySignature, selectedMask, currentLevel, count);
        const cached = this.cache.get(key);
        if (cached) {
            return {
                blueprint: cached,
                futureSignature: this.createFutureSignature(pool, cached),
                hit: true,
                candidateChecks: 0
            };
        }

        const eligibleEntryIndexes: number[] = [];
        let totalWeight = 0;
        for (let entryIndex = 0; entryIndex < pool.entries.length; entryIndex++) {
            const entry = pool.entries[entryIndex]!;
            if ((selectedMask & entry.idBit) !== 0n) continue;
            if ((selectedMask & entry.conflictBitset) !== 0n) continue;
            eligibleEntryIndexes.push(entryIndex);
            totalWeight += entry.weight;
        }

        const blueprint = Object.freeze({
            eligibleEntryIndexes: Object.freeze(eligibleEntryIndexes),
            totalWeight
        });
        this.cache.set(key, blueprint);
        return {
            blueprint,
            futureSignature: this.createFutureSignature(pool, blueprint),
            hit: false,
            candidateChecks: pool.entries.length
        };
    }

    public clear(): void {
        this.cache.clear();
    }

    private createKey(
        familySignature: SearchPoolFamilySignature,
        selectedMask: bigint,
        currentLevel: number,
        count: number
    ): string {
        return `${familySignature}|${selectedMask.toString(16)}|${currentLevel}|${count}`;
    }

    private createFutureSignature(
        pool: SearchPool,
        blueprint: SearchExpansionBlueprint
    ): SearchExpansionFutureSignature {
        const parts = blueprint.eligibleEntryIndexes.map(entryIndex => {
            const entry = pool.entries[entryIndex]!;
            return [
                entry.packedEnchant,
                entry.comboIndex,
                entry.weight,
                entry.conflictBitset.toString(16)
            ].join(':');
        });
        return `future:${blueprint.totalWeight}|${parts.join('|')}` as SearchExpansionFutureSignature;
    }
}
