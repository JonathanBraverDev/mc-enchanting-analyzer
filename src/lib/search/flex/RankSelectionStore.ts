import type { RankPoolId } from '#lib/search/flex/RankPoolStore.js';

export type FactorId = number & { readonly __brand: 'FactorId' };
export type RankPoolMixId = number & { readonly __brand: 'RankPoolMixId' };
export type SelectionId = number & { readonly __brand: 'SelectionId' };

export interface PickAlternative {
    readonly enchantId: number;
    readonly weight: number;
}

export interface PickFactor {
    readonly alternatives: readonly PickAlternative[];
    readonly totalWeight: number;
}

export interface RankPoolWeight {
    readonly rankPoolId: RankPoolId;
    readonly weight: bigint;
}

export interface RankPoolMix {
    readonly pools: readonly RankPoolWeight[];
    readonly totalWeight: bigint;
}

export interface Selection {
    readonly id: SelectionId;
    readonly rankPoolMixId: RankPoolMixId;
    readonly factors: readonly FactorId[];
}

export interface RankSelectionStoreMemoryStats {
    readonly factorCount: number;
    readonly rankPoolMixCount: number;
    readonly selectionCount: number;
}

const EMPTY_SELECTION_ID = 0 as SelectionId;

/**
 * Interns rank-agnostic picked factors and selected-state identities.
 *
 * `selectionId` is destination-state identity: factor order is canonicalized,
 * while exact rank-pool context is preserved through `rankPoolMixId`.
 */
export class RankSelectionStore {
    public readonly emptySelection: SelectionId = EMPTY_SELECTION_ID;

    private readonly factors: PickFactor[] = [];
    private readonly factorIdsByKey = new Map<string, FactorId>();
    private readonly rankPoolMixes: RankPoolMix[] = [];
    private readonly rankPoolMixIdsByKey = new Map<string, RankPoolMixId>();
    private readonly selections: Selection[] = [Object.freeze({
        id: EMPTY_SELECTION_ID,
        rankPoolMixId: this.getOrCreateRankPoolMix([]),
        factors: Object.freeze([])
    })];
    private readonly selectionIdsByKey = new Map<string, SelectionId>([['0|', EMPTY_SELECTION_ID]]);

    public getOrCreateFactor(alternatives: readonly PickAlternative[]): FactorId {
        const canonical = this.canonicalizeAlternatives(alternatives);
        const key = createFactorKey(canonical);
        const existing = this.factorIdsByKey.get(key);
        if (existing !== undefined) return existing;

        const id = this.factors.length as FactorId;
        this.factors.push(Object.freeze({
            alternatives: Object.freeze(canonical),
            totalWeight: canonical.reduce((sum, alternative) => sum + alternative.weight, 0)
        }));
        this.factorIdsByKey.set(key, id);
        return id;
    }

    public getOrCreateSingletonFactor(enchantId: number, weight: number): FactorId {
        return this.getOrCreateFactor([{ enchantId, weight }]);
    }

    public getFactor(id: FactorId): PickFactor {
        const factor = this.factors[id as number];
        if (!factor) throw new Error(`Unknown factor ID ${id}.`);
        return factor;
    }

    public getOrCreateRankPoolMix(pools: readonly RankPoolWeight[]): RankPoolMixId {
        const canonical = this.canonicalizeRankPoolWeights(pools);
        const key = createRankPoolMixKey(canonical);
        const existing = this.rankPoolMixIdsByKey.get(key);
        if (existing !== undefined) return existing;

        const id = this.rankPoolMixes.length as RankPoolMixId;
        this.rankPoolMixes.push(Object.freeze({
            pools: Object.freeze(canonical),
            totalWeight: canonical.reduce((sum, pool) => sum + pool.weight, 0n)
        }));
        this.rankPoolMixIdsByKey.set(key, id);
        return id;
    }

    public getOrCreateSinglePoolMix(rankPoolId: RankPoolId, weight: bigint): RankPoolMixId {
        return this.getOrCreateRankPoolMix([{ rankPoolId, weight }]);
    }

    public getRankPoolMix(id: RankPoolMixId): RankPoolMix {
        const mix = this.rankPoolMixes[id as number];
        if (!mix) throw new Error(`Unknown rank pool mix ID ${id}.`);
        return mix;
    }

    public getOrCreateSelection(rankPoolMixId: RankPoolMixId, factors: readonly FactorId[]): SelectionId {
        this.assertRankPoolMix(rankPoolMixId);
        const canonicalFactors = this.canonicalizeFactorIds(factors);
        const key = createSelectionKey(rankPoolMixId, canonicalFactors);
        const existing = this.selectionIdsByKey.get(key);
        if (existing !== undefined) return existing;

        const id = this.selections.length as SelectionId;
        this.selections.push(Object.freeze({
            id,
            rankPoolMixId,
            factors: Object.freeze(canonicalFactors)
        }));
        this.selectionIdsByKey.set(key, id);
        return id;
    }

    public appendFactor(selectionId: SelectionId, factorId: FactorId): SelectionId {
        this.assertFactor(factorId);
        const selection = this.getSelection(selectionId);
        if (selection.factors.includes(factorId)) {
            throw new Error(`Selection ${selectionId} already contains factor ${factorId}.`);
        }
        return this.getOrCreateSelection(selection.rankPoolMixId, [...selection.factors, factorId]);
    }

    public getSelection(id: SelectionId): Selection {
        const selection = this.selections[id as number];
        if (!selection) throw new Error(`Unknown selection ID ${id}.`);
        return selection;
    }

    public getMemoryStats(): RankSelectionStoreMemoryStats {
        return {
            factorCount: this.factors.length,
            rankPoolMixCount: this.rankPoolMixes.length,
            selectionCount: this.selections.length
        };
    }

    private canonicalizeAlternatives(alternatives: readonly PickAlternative[]): PickAlternative[] {
        if (alternatives.length === 0) throw new Error('Cannot create an empty pick factor.');

        const weightsByEnchant = new Map<number, number>();
        for (const alternative of alternatives) {
            if (!Number.isInteger(alternative.enchantId) || alternative.enchantId < 0) {
                throw new Error('Pick factor enchant IDs must be non-negative integers.');
            }
            if (!Number.isInteger(alternative.weight) || alternative.weight <= 0) {
                throw new Error('Pick factor weights must be positive integers.');
            }
            weightsByEnchant.set(
                alternative.enchantId,
                (weightsByEnchant.get(alternative.enchantId) ?? 0) + alternative.weight
            );
        }

        return [...weightsByEnchant.entries()]
            .sort(([left], [right]) => left - right)
            .map(([enchantId, weight]) => Object.freeze({ enchantId, weight }));
    }

    private canonicalizeRankPoolWeights(pools: readonly RankPoolWeight[]): RankPoolWeight[] {
        const weightsByPool = new Map<RankPoolId, bigint>();
        for (const pool of pools) {
            if (pool.weight <= 0n) throw new Error('Rank pool mix weights must be positive.');
            weightsByPool.set(
                pool.rankPoolId,
                (weightsByPool.get(pool.rankPoolId) ?? 0n) + pool.weight
            );
        }

        return [...weightsByPool.entries()]
            .sort(([left], [right]) => Number(left) - Number(right))
            .map(([rankPoolId, weight]) => Object.freeze({ rankPoolId, weight }));
    }

    private canonicalizeFactorIds(factors: readonly FactorId[]): FactorId[] {
        const sorted = [...factors].sort((left, right) => Number(left) - Number(right));
        for (let index = 0; index < sorted.length; index++) {
            const factorId = sorted[index]!;
            this.assertFactor(factorId);
            if (index > 0 && sorted[index - 1] === factorId) {
                throw new Error(`Selection factors must be unique; repeated factor ${factorId}.`);
            }
        }
        return sorted;
    }

    private assertFactor(id: FactorId): void {
        if (!this.factors[id as number]) throw new Error(`Unknown factor ID ${id}.`);
    }

    private assertRankPoolMix(id: RankPoolMixId): void {
        if (!this.rankPoolMixes[id as number]) throw new Error(`Unknown rank pool mix ID ${id}.`);
    }
}

function createFactorKey(alternatives: readonly PickAlternative[]): string {
    return alternatives
        .map(alternative => `${alternative.enchantId}:${alternative.weight}`)
        .join(',');
}

function createRankPoolMixKey(pools: readonly RankPoolWeight[]): string {
    return pools
        .map(pool => `${String(pool.rankPoolId)}:${String(pool.weight)}`)
        .join(',');
}

function createSelectionKey(rankPoolMixId: RankPoolMixId, factors: readonly FactorId[]): string {
    return `${String(rankPoolMixId)}|${factors.map(String).join(',')}`;
}
