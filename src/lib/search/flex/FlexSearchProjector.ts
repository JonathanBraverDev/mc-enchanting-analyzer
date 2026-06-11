import type { PackedCombo } from '#types/index.js';
import { PACKING_CONSTANTS } from '#constants/engine.js';
import type { PendingClueJointAggregates, PendingFrontierAggregates } from '#lib/search/SearchSnapshot.js';
import type { RankPoolId, RankPoolStore } from '#lib/search/flex/RankPoolStore.js';
import type { FactorId, FactorSetId, RankSelectionStore, SelectionId } from '#lib/search/flex/RankSelectionStore.js';
import type { FlexSearchPendingEntry } from '#lib/search/flex/FlexSearchRun.js';

type FlexSearchProjectionFactorVisitor = (
    combo: PackedCombo,
    count: number,
    numerator: bigint,
    denominator: bigint,
    matchesTargetClue: boolean
) => void;

export interface FlexSearchProjectionOptions {
    readonly applyBookRemoval?: boolean | undefined;
    readonly targetClueId?: number | undefined;
    readonly indexToEnchant?: readonly number[] | undefined;
}

export interface FlexSearchProjectionResult {
    readonly results: ReadonlyMap<PackedCombo, bigint>;
    readonly projectionLoss: bigint;
    readonly clueIncompatible: bigint;
    readonly projectedMass: bigint;
    readonly sourceMass: bigint;
}

export interface FlexSearchProjectedPendingAggregateResults {
    readonly pendingAggregates: PendingFrontierAggregates;
    readonly projectionLoss: bigint;
    readonly clueIncompatible: bigint;
    readonly projectedMass: bigint;
    readonly sourceMass: bigint;
}

export interface FlexSearchPendingProjectionEntry extends FlexSearchPendingEntry {
    readonly count: number;
    readonly targetClueReachable?: boolean | undefined;
}

export class FlexSearchProjector {
    public constructor(
        private readonly rankPools: RankPoolStore,
        private readonly selections: RankSelectionStore,
        private readonly enchantToIndex: Map<number, number>,
        public readonly options: FlexSearchProjectionOptions = {}
    ) {}

    public projectResults(results: ReadonlyMap<SelectionId, bigint>): FlexSearchProjectionResult {
        const projected = new Map<PackedCombo, bigint>();
        let sourceMass = 0n;
        let projectedMass = 0n;
        let projectionLoss = 0n;
        let clueIncompatible = 0n;

        for (const [selectionId, mass] of results) {
            const selection = this.selections.getSelection(selectionId);
            const rankPoolMix = this.selections.getRankPoolMix(selection.rankPoolMixId);
            if (rankPoolMix.totalWeight !== mass) {
                throw new Error(`Flex projection expected selection mix total ${rankPoolMix.totalWeight} to equal source mass ${mass}.`);
            }

            for (const pool of rankPoolMix.pools) {
                sourceMass += pool.weight;
                let assigned = 0n;

                this.visitSelectionFactors(selectionId, pool.rankPoolId, (combo, _count, numerator, denominator, matchesTargetClue) => {
                    const share = (pool.weight * numerator) / denominator;
                    assigned += share;
                    if (share === 0n) return;

                    if (!this.isClueCompatible(matchesTargetClue)) {
                        clueIncompatible += share;
                        return;
                    }

                    projectedMass += share;
                    if (combo !== 0) {
                        projected.set(combo, (projected.get(combo) ?? 0n) + share);
                    }
                });

                projectionLoss += pool.weight - assigned;
            }
        }

        return Object.freeze({
            results: new Map(projected),
            projectionLoss,
            clueIncompatible,
            projectedMass,
            sourceMass
        });
    }

    public projectPendingAggregates(entries: readonly FlexSearchPendingProjectionEntry[]): FlexSearchProjectedPendingAggregateResults {
        const pendingAggregates = createPendingAggregates();
        const clueJoint = this.options.targetClueId === undefined
            ? undefined
            : createPendingClueJointAggregates(this.options.targetClueId);
        let sourceMass = 0n;
        let projectedMass = 0n;
        let projectionLoss = 0n;
        let clueIncompatible = 0n;

        for (const entry of entries) {
            const rankPoolMix = this.selections.getRankPoolMix(entry.rankPoolMixId);
            if (rankPoolMix.totalWeight !== entry.mass) {
                throw new Error(`Flex pending projection expected mix total ${rankPoolMix.totalWeight} to equal source mass ${entry.mass}.`);
            }

            for (const pool of rankPoolMix.pools) {
                sourceMass += pool.weight;

                if (clueJoint) {
                    const split = this.getPendingClueSplit(
                        entry.factorSetId,
                        pool.rankPoolId,
                        pool.weight,
                        entry.count,
                        entry.targetClueReachable
                    );
                    projectedMass += split.projectedMass;
                    clueIncompatible += split.clueIncompatible;
                    projectionLoss += split.projectionLoss;

                    if (split.clueKnownSpace > 0n) {
                        addMapMass(
                            pendingAggregates.shownClueDistribution,
                            clueJoint.targetClueId,
                            split.clueKnownSpace
                        );
                        this.addPendingClueJointAggregate(
                            clueJoint,
                            entry.factorSetId,
                            pool.rankPoolId,
                            split.clueKnownSpace,
                            entry.count
                        );
                    }
                    continue;
                }

                projectedMass += pool.weight;
                this.addPendingFactorSetAggregate(
                    pendingAggregates,
                    entry.factorSetId,
                    pool.rankPoolId,
                    pool.weight,
                    entry.count
                );
            }
        }

        return Object.freeze({
            pendingAggregates: freezePendingAggregates(pendingAggregates, clueJoint),
            projectionLoss,
            clueIncompatible,
            projectedMass,
            sourceMass
        });
    }

    private getPendingClueSplit(
        factorSetId: FactorSetId,
        rankPoolId: RankPoolId,
        mass: bigint,
        count: number,
        targetClueReachable: boolean | undefined
    ): {
        readonly projectedMass: bigint;
        readonly clueIncompatible: bigint;
        readonly projectionLoss: bigint;
        readonly clueKnownSpace: bigint;
    } {
        const targetClueId = this.options.targetClueId;
        if (targetClueId === undefined) {
            return { projectedMass: mass, clueIncompatible: 0n, projectionLoss: 0n, clueKnownSpace: 0n };
        }

        for (const factorId of this.selections.getFactorSet(factorSetId).factors) {
            const factor = this.selections.getFactor(factorId);
            const targetAlternative = factor.alternatives.find(alternative =>
                this.rankPools.resolve(rankPoolId, alternative.enchantId) === targetClueId
            );
            if (!targetAlternative) continue;

            const totalWeight = BigInt(factor.totalWeight);
            const targetWeight = BigInt(targetAlternative.weight);
            const nonTargetWeight = totalWeight - targetWeight;
            const targetMass = (mass * targetWeight) / totalWeight;
            const nonTargetMass = (mass * nonTargetWeight) / totalWeight;
            const splitLoss = mass - targetMass - nonTargetMass;
            const nonTargetCanStillReachClue = targetClueReachable === true;

            return {
                projectedMass: targetMass + (nonTargetCanStillReachClue ? nonTargetMass : 0n),
                clueIncompatible: nonTargetCanStillReachClue ? 0n : nonTargetMass,
                projectionLoss: splitLoss,
                clueKnownSpace: count > 0 ? targetMass / BigInt(count) : 0n
            };
        }

        return targetClueReachable === true
            ? { projectedMass: mass, clueIncompatible: 0n, projectionLoss: 0n, clueKnownSpace: 0n }
            : { projectedMass: 0n, clueIncompatible: mass, projectionLoss: 0n, clueKnownSpace: 0n };
    }

    private addPendingFactorSetAggregate(
        pendingAggregates: MutablePendingFrontierAggregates,
        factorSetId: FactorSetId,
        rankPoolId: RankPoolId,
        mass: bigint,
        count: number
    ): void {
        if (mass <= 0n) return;

        const displayCount = this.options.applyBookRemoval && count > 1 ? count - 1 : count;
        addArrayMass(pendingAggregates.count, displayCount, mass);
        if (count <= 0) return;

        const clueQuotient = mass / BigInt(count);
        const clueRemainder = Number(mass % BigInt(count));
        const factors = this.selections.getFactorSet(factorSetId).factors;

        for (let factorIndex = 0; factorIndex < factors.length; factorIndex++) {
            const factor = this.selections.getFactor(factors[factorIndex]!);
            const clueSlotMass = clueQuotient + (factorIndex < clueRemainder ? 1n : 0n);
            const totalWeight = BigInt(factor.totalWeight);

            for (const alternative of factor.alternatives) {
                const packedEnchant = this.rankPools.resolve(rankPoolId, alternative.enchantId);
                if (packedEnchant === null) {
                    throw new Error(`Rank pool ${rankPoolId} cannot resolve enchant ID ${alternative.enchantId}.`);
                }

                this.addPendingEmissionAggregate(
                    pendingAggregates,
                    packedEnchant,
                    (mass * BigInt(alternative.weight)) / totalWeight,
                    (clueSlotMass * BigInt(alternative.weight)) / totalWeight,
                    count
                );
            }
        }
    }

    private addPendingEmissionAggregate(
        pendingAggregates: MutablePendingFrontierAggregates,
        packedEnchant: number,
        mass: bigint,
        clueMass: bigint,
        count: number
    ): void {
        if (mass <= 0n || !this.enchantToIndex.has(packedEnchant)) return;

        const aggregateMass = this.options.applyBookRemoval && count > 1
            ? (mass * BigInt(count - 1)) / BigInt(count)
            : mass;
        const id = packedEnchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        addArrayMass(pendingAggregates.any, id, aggregateMass);
        addArrayMass(pendingAggregates.ranks, packedEnchant, aggregateMass);

        if (clueMass > 0n) {
            addMapMass(pendingAggregates.shownClueDistribution, packedEnchant, clueMass);
        }
    }

    private addPendingClueJointAggregate(
        clueJoint: MutablePendingClueJointAggregates,
        factorSetId: FactorSetId,
        rankPoolId: RankPoolId,
        clueMass: bigint,
        count: number
    ): void {
        if (clueMass <= 0n) return;

        clueJoint.knownSpace += clueMass;
        const displayCount = this.options.applyBookRemoval && count > 1 ? count - 1 : count;
        addArrayMass(clueJoint.count, displayCount, clueMass);

        const targetClueId = clueJoint.targetClueId;
        const factors = this.selections.getFactorSet(factorSetId).factors;
        for (const factorId of factors) {
            const factor = this.selections.getFactor(factorId);
            const targetAlternative = factor.alternatives.find(alternative =>
                this.rankPools.resolve(rankPoolId, alternative.enchantId) === targetClueId
            );
            if (targetAlternative) {
                this.addPendingClueJointEmissionAggregate(clueJoint, targetClueId, clueMass, count);
                continue;
            }

            const totalWeight = BigInt(factor.totalWeight);
            for (const alternative of factor.alternatives) {
                const packedEnchant = this.rankPools.resolve(rankPoolId, alternative.enchantId);
                if (packedEnchant === null) {
                    throw new Error(`Rank pool ${rankPoolId} cannot resolve enchant ID ${alternative.enchantId}.`);
                }
                this.addPendingClueJointEmissionAggregate(
                    clueJoint,
                    packedEnchant,
                    (clueMass * BigInt(alternative.weight)) / totalWeight,
                    count
                );
            }
        }
    }

    private addPendingClueJointEmissionAggregate(
        clueJoint: MutablePendingClueJointAggregates,
        packedEnchant: number,
        mass: bigint,
        count: number
    ): void {
        if (mass <= 0n || !this.enchantToIndex.has(packedEnchant)) return;

        const aggregateMass = this.options.applyBookRemoval && count > 1
            ? (mass * BigInt(count - 1)) / BigInt(count)
            : mass;
        const id = packedEnchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        addArrayMass(clueJoint.any, id, aggregateMass);
        addArrayMass(clueJoint.ranks, packedEnchant, aggregateMass);
    }

    private visitSelectionFactors(
        selectionId: SelectionId,
        rankPoolId: RankPoolId,
        visitor: FlexSearchProjectionFactorVisitor
    ): void {
        const selection = this.selections.getSelection(selectionId);
        this.visitFactorSetFactors(selection.factorSetId, rankPoolId, visitor);
    }

    private visitFactorSetFactors(
        factorSetId: FactorSetId,
        rankPoolId: RankPoolId,
        visitor: FlexSearchProjectionFactorVisitor
    ): void {
        const factors = this.selections.getFactorSet(factorSetId).factors;

        if (this.options.applyBookRemoval && factors.length >= 2) {
            const slotDenominator = BigInt(factors.length);
            for (let removedFactorIndex = 0; removedFactorIndex < factors.length; removedFactorIndex++) {
                this.visitFactors(factors, rankPoolId, visitor, removedFactorIndex, slotDenominator);
            }
            return;
        }

        this.visitFactors(factors, rankPoolId, visitor);
    }

    private visitFactors(
        factors: readonly FactorId[],
        rankPoolId: RankPoolId,
        visitor: FlexSearchProjectionFactorVisitor,
        removedFactorIndex?: number,
        initialDenominator: bigint = 1n
    ): void {
        const visit = (
            factorIndex: number,
            combo: PackedCombo,
            count: number,
            numerator: bigint,
            denominator: bigint,
            matchesTargetClue: boolean
        ): void => {
            if (factorIndex >= factors.length) {
                visitor(combo, count, numerator, denominator, matchesTargetClue);
                return;
            }

            if (factorIndex === removedFactorIndex) {
                visit(factorIndex + 1, combo, count, numerator, denominator, matchesTargetClue);
                return;
            }

            const factor = this.selections.getFactor(factors[factorIndex]!);
            const totalWeight = BigInt(factor.totalWeight);
            for (const alternative of factor.alternatives) {
                const packedEnchant = this.rankPools.resolve(rankPoolId, alternative.enchantId);
                if (packedEnchant === null) {
                    throw new Error(`Rank pool ${rankPoolId} cannot resolve enchant ID ${alternative.enchantId}.`);
                }

                const packedIndex = this.enchantToIndex.get(packedEnchant);
                visit(
                    factorIndex + 1,
                    packedIndex === undefined ? combo : appendPackedComboIndex(combo, packedIndex, count),
                    packedIndex === undefined ? count : count + 1,
                    numerator * BigInt(alternative.weight),
                    denominator * totalWeight,
                    matchesTargetClue || packedEnchant === this.options.targetClueId
                );
            }
        };

        visit(0, 0 as PackedCombo, 0, 1n, initialDenominator, false);
    }

    private isClueCompatible(matchesTargetClue: boolean): boolean {
        return this.options.targetClueId === undefined || matchesTargetClue;
    }
}

function appendPackedComboIndex(combo: PackedCombo, packedIndex: number, count: number): PackedCombo {
    if (count === 0) return packedIndex as PackedCombo;

    let insertMultiplier = 1;
    for (let index = 0; index < count; index++, insertMultiplier *= PACKING_CONSTANTS.BYTE_BASIS) {
        const current = Math.floor(combo / insertMultiplier) % PACKING_CONSTANTS.BYTE_BASIS;
        if (packedIndex > current) break;
    }

    const lowerDigits = combo % insertMultiplier;
    const shiftedDigits = (combo - lowerDigits) * PACKING_CONSTANTS.BYTE_BASIS;
    return (lowerDigits + packedIndex * insertMultiplier + shiftedDigits) as PackedCombo;
}

type MutablePendingFrontierAggregates = {
    any: bigint[];
    ranks: bigint[];
    count: bigint[];
    shownClueDistribution: Map<number, bigint>;
};

type MutablePendingClueJointAggregates = {
    targetClueId: number;
    knownSpace: bigint;
    any: bigint[];
    ranks: bigint[];
    count: bigint[];
};

function createPendingAggregates(): MutablePendingFrontierAggregates {
    return {
        any: [],
        ranks: [],
        count: [],
        shownClueDistribution: new Map()
    };
}

function createPendingClueJointAggregates(targetClueId: number): MutablePendingClueJointAggregates {
    return {
        targetClueId,
        knownSpace: 0n,
        any: [],
        ranks: [],
        count: []
    };
}

function freezePendingAggregates(
    source: MutablePendingFrontierAggregates,
    clueJoint: MutablePendingClueJointAggregates | undefined
): PendingFrontierAggregates {
    return Object.freeze({
        any: Object.freeze(source.any.slice()),
        ranks: Object.freeze(source.ranks.slice()),
        count: Object.freeze(source.count.slice()),
        shownClueDistribution: new Map(source.shownClueDistribution),
        ...(clueJoint
            ? {
                clueJoint: Object.freeze({
                    targetClueId: clueJoint.targetClueId,
                    knownSpace: clueJoint.knownSpace,
                    any: Object.freeze(clueJoint.any.slice()),
                    ranks: Object.freeze(clueJoint.ranks.slice()),
                    count: Object.freeze(clueJoint.count.slice())
                }) satisfies PendingClueJointAggregates
            }
            : {})
    });
}

function addArrayMass(target: bigint[], key: number, mass: bigint): void {
    if (mass === 0n) return;
    target[key] = (target[key] ?? 0n) + mass;
}

function addMapMass<K>(target: Map<K, bigint>, key: K, mass: bigint): void {
    if (mass === 0n) return;
    const next = (target.get(key) ?? 0n) + mass;
    if (next === 0n) target.delete(key);
    else target.set(key, next);
}
