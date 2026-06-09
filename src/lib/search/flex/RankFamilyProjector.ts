import type { PackedCombo } from '#types/index.js';
import { PACKING_CONSTANTS } from '#constants/engine.js';
import type { RankPoolId, RankPoolStore } from '#lib/search/flex/RankPoolStore.js';
import type { FactorId, RankSelectionStore, SelectionId } from '#lib/search/flex/RankSelectionStore.js';

type RankFamilyProjectionFactorVisitor = (
    combo: PackedCombo,
    count: number,
    numerator: bigint,
    denominator: bigint,
    matchesTargetClue: boolean
) => void;

export interface RankFamilyProjectionOptions {
    readonly applyBookRemoval?: boolean | undefined;
    readonly targetClueId?: number | undefined;
}

export interface RankFamilyProjectionResult {
    readonly results: ReadonlyMap<PackedCombo, bigint>;
    readonly projectionLoss: bigint;
    readonly clueIncompatible: bigint;
    readonly projectedMass: bigint;
    readonly sourceMass: bigint;
}

export class RankFamilyProjector {
    public constructor(
        private readonly rankPools: RankPoolStore,
        private readonly selections: RankSelectionStore,
        private readonly enchantToIndex: Map<number, number>,
        private readonly options: RankFamilyProjectionOptions = {}
    ) {}

    public projectResults(results: ReadonlyMap<SelectionId, bigint>): RankFamilyProjectionResult {
        const projected = new Map<PackedCombo, bigint>();
        let sourceMass = 0n;
        let projectedMass = 0n;
        let projectionLoss = 0n;
        let clueIncompatible = 0n;

        for (const [selectionId, mass] of results) {
            const selection = this.selections.getSelection(selectionId);
            const rankPoolMix = this.selections.getRankPoolMix(selection.rankPoolMixId);
            if (rankPoolMix.totalWeight !== mass) {
                throw new Error(`Rank-family projection expected selection mix total ${rankPoolMix.totalWeight} to equal source mass ${mass}.`);
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

    private visitSelectionFactors(
        selectionId: SelectionId,
        rankPoolId: RankPoolId,
        visitor: RankFamilyProjectionFactorVisitor
    ): void {
        const selection = this.selections.getSelection(selectionId);
        const factors = selection.factors;

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
        visitor: RankFamilyProjectionFactorVisitor,
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
