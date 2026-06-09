import type { RankPoolId } from '#lib/search/flex/RankPoolStore.js';

export type FactorId = number & { readonly __brand: 'FactorId' };
export type FactorSetId = number & { readonly __brand: 'FactorSetId' };
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

export interface FactorSet {
    readonly id: FactorSetId;
    readonly factors: readonly FactorId[];
}

export interface Selection {
    readonly id: SelectionId;
    readonly factorSetId: FactorSetId;
    readonly rankPoolMixId: RankPoolMixId;
    readonly factors: readonly FactorId[];
}

export interface RankSelectionStoreMemoryStats {
    readonly factorCount: number;
    readonly factorSetCount: number;
    readonly rankPoolMixCount: number;
    readonly selectionCount: number;
}

const EMPTY_FACTOR_SET_ID = 0 as FactorSetId;
const EMPTY_SELECTION_ID = 0 as SelectionId;

/**
 * Interns rank-agnostic picked factors and selected-state identities.
 *
 * `factorSetId` is the rank-agnostic selected-state component used for
 * frontier merging. `selectionId` adds exact rank-pool context for projection.
 */
export class RankSelectionStore {
    public readonly emptyFactorSet: FactorSetId = EMPTY_FACTOR_SET_ID;
    public readonly emptySelection: SelectionId = EMPTY_SELECTION_ID;

    private readonly factors: PickFactor[] = [];
    private readonly factorIdsByKey = new Map<string, FactorId>();
    private readonly factorSets: FactorSet[] = [Object.freeze({
        id: EMPTY_FACTOR_SET_ID,
        factors: Object.freeze([])
    })];
    private readonly factorSetIdsByKey = new Map<string, FactorSetId>([['', EMPTY_FACTOR_SET_ID]]);
    private readonly rankPoolMixes: RankPoolMix[] = [];
    private readonly rankPoolMixIdsByKey = new Map<string, RankPoolMixId>();
    private readonly emptyRankPoolMixId = this.getOrCreateRankPoolMix([]);
    private readonly selections: Selection[] = [Object.freeze({
        id: EMPTY_SELECTION_ID,
        factorSetId: EMPTY_FACTOR_SET_ID,
        rankPoolMixId: this.emptyRankPoolMixId,
        factors: Object.freeze([])
    })];
    private readonly selectionIdsByKey = new Map<string, SelectionId>([
        [createSelectionKey(this.emptyRankPoolMixId, EMPTY_FACTOR_SET_ID), EMPTY_SELECTION_ID]
    ]);

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

    public mergeRankPoolMixes(mixes: readonly RankPoolMixId[]): RankPoolMixId {
        const pools: RankPoolWeight[] = [];
        for (const mixId of mixes) {
            const mix = this.getRankPoolMix(mixId);
            pools.push(...mix.pools);
        }
        return this.getOrCreateRankPoolMix(pools);
    }

    public scaleRankPoolMix(mixId: RankPoolMixId, targetWeight: bigint): RankPoolMixId {
        if (targetWeight <= 0n) throw new Error('Scaled rank pool mix weight must be positive.');

        const mix = this.getRankPoolMix(mixId);
        if (mix.totalWeight <= 0n) throw new Error(`Cannot scale empty rank pool mix ${mixId}.`);
        if (mix.totalWeight === targetWeight) return mixId;

        return this.getOrCreateRankPoolMix(splitWeightByPools(mix.pools, targetWeight, mix.totalWeight));
    }

    public getOrCreateFactorSet(factors: readonly FactorId[]): FactorSetId {
        const canonicalFactors = this.canonicalizeFactorIds(factors);
        const key = createFactorSetKey(canonicalFactors);
        const existing = this.factorSetIdsByKey.get(key);
        if (existing !== undefined) return existing;

        const id = this.factorSets.length as FactorSetId;
        this.factorSets.push(Object.freeze({
            id,
            factors: Object.freeze(canonicalFactors)
        }));
        this.factorSetIdsByKey.set(key, id);
        return id;
    }

    public appendFactorToSet(factorSetId: FactorSetId, factorId: FactorId): FactorSetId {
        this.assertFactor(factorId);
        const factorSet = this.getFactorSet(factorSetId);
        if (factorSet.factors.includes(factorId)) {
            throw new Error(`Factor set ${factorSetId} already contains factor ${factorId}.`);
        }
        return this.getOrCreateFactorSet([...factorSet.factors, factorId]);
    }

    public getFactorSet(id: FactorSetId): FactorSet {
        const factorSet = this.factorSets[id as number];
        if (!factorSet) throw new Error(`Unknown factor set ID ${id}.`);
        return factorSet;
    }

    public getOrCreateSelection(rankPoolMixId: RankPoolMixId, factorSetId: FactorSetId): SelectionId {
        this.assertRankPoolMix(rankPoolMixId);
        const factorSet = this.getFactorSet(factorSetId);
        const key = createSelectionKey(rankPoolMixId, factorSetId);
        const existing = this.selectionIdsByKey.get(key);
        if (existing !== undefined) return existing;

        const id = this.selections.length as SelectionId;
        this.selections.push(Object.freeze({
            id,
            factorSetId,
            rankPoolMixId,
            factors: factorSet.factors
        }));
        this.selectionIdsByKey.set(key, id);
        return id;
    }

    public getOrCreateSelectionForFactors(rankPoolMixId: RankPoolMixId, factors: readonly FactorId[]): SelectionId {
        return this.getOrCreateSelection(rankPoolMixId, this.getOrCreateFactorSet(factors));
    }

    public appendFactor(selectionId: SelectionId, factorId: FactorId): SelectionId {
        this.assertFactor(factorId);
        const selection = this.getSelection(selectionId);
        const factorSetId = this.appendFactorToSet(selection.factorSetId, factorId);
        return this.getOrCreateSelection(selection.rankPoolMixId, factorSetId);
    }

    public getSelection(id: SelectionId): Selection {
        const selection = this.selections[id as number];
        if (!selection) throw new Error(`Unknown selection ID ${id}.`);
        return selection;
    }

    public getMemoryStats(): RankSelectionStoreMemoryStats {
        return {
            factorCount: this.factors.length,
            factorSetCount: this.factorSets.length,
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

function createFactorSetKey(factors: readonly FactorId[]): string {
    return factors.map(String).join(',');
}

function createSelectionKey(rankPoolMixId: RankPoolMixId, factorSetId: FactorSetId): string {
    return `${String(rankPoolMixId)}|${String(factorSetId)}`;
}

function splitWeightByPools(
    pools: readonly RankPoolWeight[],
    targetWeight: bigint,
    sourceWeight: bigint
): RankPoolWeight[] {
    const split = pools.map(pool => {
        const scaledNumerator = pool.weight * targetWeight;
        return {
            rankPoolId: pool.rankPoolId,
            weight: scaledNumerator / sourceWeight,
            remainder: scaledNumerator % sourceWeight
        };
    });

    let assigned = split.reduce((sum, pool) => sum + pool.weight, 0n);
    let remainder = targetWeight - assigned;
    split.sort((left, right) => {
        if (left.remainder === right.remainder) return Number(left.rankPoolId) - Number(right.rankPoolId);
        return left.remainder > right.remainder ? -1 : 1;
    });

    for (const pool of split) {
        if (remainder === 0n) break;
        pool.weight++;
        assigned++;
        remainder--;
    }

    if (assigned !== targetWeight) {
        throw new Error(`Scaled rank pool mix lost ${targetWeight - assigned} weight units.`);
    }

    return split
        .filter(pool => pool.weight > 0n)
        .sort((left, right) => Number(left.rankPoolId) - Number(right.rankPoolId))
        .map(pool => Object.freeze({
            rankPoolId: pool.rankPoolId,
            weight: pool.weight
        }));
}
