import type { PackedCombo } from '#types/index.js';
import { PACKING_CONSTANTS } from '#constants/engine.js';
import type { PendingClueJointAggregates, PendingFrontierAggregates } from '#lib/search/SearchRun.js';
import type {
    FlexPendingEntry,
    FlexProgram,
    FlexProjectedPendingAggregateResults,
    FlexProjectedPendingEntry,
    FlexProjectedPendingResults,
    FlexProjectedResults,
    FlexProgramId
} from '#lib/search/flex/FlexTypes.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';

type FlexProjectionFactorVisitor = (
    combo: PackedCombo,
    count: number,
    numerator: bigint,
    denominator: bigint,
    matchesTargetClue: boolean
) => void;

export type FlexResultProjectionFactorVisitor = FlexProjectionFactorVisitor;

export type FlexPendingAggregateVisitor = (
    programId: FlexProgramId,
    mass: bigint,
    count: number,
    targetClueReachable?: boolean | undefined
) => void;

export interface FlexProjectionOptions {
    readonly applyBookRemoval?: boolean | undefined;
    readonly targetClueId?: number | undefined;
}

export class FlexProjector {
    public constructor(
        private readonly programs: FlexProgramStore,
        private readonly enchantToIndex: Map<number, number>,
        private readonly options: FlexProjectionOptions = {}
    ) {}

    private readonly pendingProgramScratch: FlexProgram[number][] = [];

    public projectResults(results: ReadonlyMap<FlexProgramId, bigint>): FlexProjectedResults {
        const projected = new Map<PackedCombo, bigint>();
        let sourceMass = 0n;
        let projectedMass = 0n;
        let projectionLoss = 0n;
        let clueIncompatible = 0n;

        for (const [programId, mass] of results) {
            sourceMass += mass;

            let assigned = 0n;
            this.visitResultProgramFactors(programId, (combo, _count, numerator, denominator, matchesTargetClue) => {
                const share = (mass * numerator) / denominator;
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
            projectionLoss += mass - assigned;
        }

        return Object.freeze({
            results: new Map(projected),
            projectionLoss,
            clueIncompatible,
            projectedMass,
            sourceMass
        });
    }

    public projectPending(entries: readonly FlexPendingEntry[]): readonly FlexProjectedPendingEntry[] {
        return this.projectPendingWithDiagnostics(entries).pendingEntries;
    }

    public projectPendingWithDiagnostics(entries: readonly FlexPendingEntry[]): FlexProjectedPendingResults {
        const pendingEntries: FlexProjectedPendingEntry[] = [];
        let sourceMass = 0n;
        let projectedMass = 0n;
        let projectionLoss = 0n;
        let clueIncompatible = 0n;

        for (const entry of entries) {
            const program = this.programs.getProgram(entry.programId);
            sourceMass += entry.mass;

            let assigned = 0n;
            this.visitProgramFactors(program, (combo, count, numerator, denominator, matchesTargetClue) => {
                const share = (entry.mass * numerator) / denominator;
                assigned += share;
                if (share === 0n) return;

                if (!this.isPendingClueCompatible(matchesTargetClue, entry.targetClueReachable)) {
                    clueIncompatible += share;
                    return;
                }

                projectedMass += share;
                pendingEntries.push({
                    graphId: entry.graphId,
                    nodeId: entry.nodeId,
                    mass: share,
                    combo,
                    count
                });
            });
            projectionLoss += entry.mass - assigned;
        }

        return Object.freeze({
            pendingEntries: Object.freeze(pendingEntries),
            projectionLoss,
            clueIncompatible,
            projectedMass,
            sourceMass
        });
    }

    public visitResultProgramFactors(programId: FlexProgramId, visitor: FlexResultProjectionFactorVisitor): void {
        this.forEachResultProgramFactor(this.programs.getProgram(programId), visitor);
    }

    public isResultClueCompatible(matchesTargetClue: boolean): boolean {
        return this.isClueCompatible(matchesTargetClue);
    }

    public projectPendingAggregates(entries: readonly FlexPendingEntry[]): FlexProjectedPendingAggregateResults {
        return this.projectPendingAggregatesFromCursor(visitor => {
            for (const entry of entries) {
                visitor(entry.programId, entry.mass, entry.count, entry.targetClueReachable);
            }
        });
    }

    public projectPendingAggregatesFromCursor(
        visitEntries: (visitor: FlexPendingAggregateVisitor) => void
    ): FlexProjectedPendingAggregateResults {
        const pendingAggregates = createPendingAggregates();
        const clueJoint = this.options.targetClueId === undefined
            ? undefined
            : createPendingClueJointAggregates(this.options.targetClueId);
        let sourceMass = 0n;
        let projectedMass = 0n;
        let projectionLoss = 0n;
        let clueIncompatible = 0n;

        visitEntries((programId, mass, count, targetClueReachable) => {
            sourceMass += mass;
            if (mass === 0n) return;

            if (clueJoint) {
                const split = this.getPendingClueSplit(programId, mass, count, targetClueReachable);
                projectedMass += split.projectedMass;
                clueIncompatible += split.clueIncompatible;
                projectionLoss += split.projectionLoss;

                if (split.clueKnownSpace > 0n) {
                    pendingAggregates.shownClueDistribution.set(
                        clueJoint.targetClueId,
                        (pendingAggregates.shownClueDistribution.get(clueJoint.targetClueId) ?? 0n) + split.clueKnownSpace
                    );
                    this.addPendingClueJointAggregate(clueJoint, programId, split.clueKnownSpace, count);
                }
                return;
            }

            projectedMass += mass;
            this.addPendingProgramAggregate(
                pendingAggregates,
                programId,
                mass,
                count
            );
        });

        return Object.freeze({
            pendingAggregates: freezePendingAggregates(pendingAggregates, clueJoint),
            projectionLoss,
            clueIncompatible,
            projectedMass,
            sourceMass
        });
    }

    private getPendingClueSplit(
        programId: FlexProgramId,
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

        let split: {
            projectedMass: bigint;
            clueIncompatible: bigint;
            projectionLoss: bigint;
            clueKnownSpace: bigint;
        } | undefined;

        const programLength = this.programs.writeProgramEmissions(programId, this.pendingProgramScratch);
        for (let emissionIndex = 0; emissionIndex < programLength; emissionIndex++) {
            const emission = this.pendingProgramScratch[emissionIndex]!;
            if (emission.kind === 'fixed') {
                if (emission.packedEnchant === targetClueId) {
                    split = {
                        projectedMass: mass,
                        clueIncompatible: 0n,
                        projectionLoss: 0n,
                        clueKnownSpace: count > 0 ? mass / BigInt(count) : 0n
                    };
                    break;
                }
                continue;
            }

            const targetAlternative = emission.alternatives.find(alternative => alternative.packedEnchant === targetClueId);
            if (!targetAlternative) continue;

            const totalWeight = BigInt(emission.totalWeight);
            const targetWeight = BigInt(targetAlternative.weight);
            const nonTargetWeight = totalWeight - targetWeight;
            const targetMass = (mass * targetWeight) / totalWeight;
            const nonTargetMass = (mass * nonTargetWeight) / totalWeight;
            const splitLoss = mass - targetMass - nonTargetMass;
            const nonTargetCanStillReachClue = targetClueReachable === true;

            split = {
                projectedMass: targetMass + (nonTargetCanStillReachClue ? nonTargetMass : 0n),
                clueIncompatible: nonTargetCanStillReachClue ? 0n : nonTargetMass,
                projectionLoss: splitLoss,
                clueKnownSpace: count > 0 ? targetMass / BigInt(count) : 0n
            };
            break;
        }

        if (split) return split;

        return targetClueReachable === true
            ? { projectedMass: mass, clueIncompatible: 0n, projectionLoss: 0n, clueKnownSpace: 0n }
            : { projectedMass: 0n, clueIncompatible: mass, projectionLoss: 0n, clueKnownSpace: 0n };
    }

    private forEachResultProgramFactor(
        program: FlexProgram,
        visitor: FlexProjectionFactorVisitor
    ): void {
        if (this.options.applyBookRemoval && program.length >= 2) {
            const slotDenominator = BigInt(program.length);
            for (let removedEmissionIndex = 0; removedEmissionIndex < program.length; removedEmissionIndex++) {
                this.visitProgramFactors(program, visitor, removedEmissionIndex, slotDenominator);
            }
            return;
        }

        this.visitProgramFactors(program, visitor);
    }

    private isClueCompatible(matchesTargetClue: boolean): boolean {
        return this.options.targetClueId === undefined || matchesTargetClue;
    }

    private isPendingClueCompatible(matchesTargetClue: boolean, targetClueReachable: boolean | undefined): boolean {
        return this.options.targetClueId === undefined || matchesTargetClue || targetClueReachable === true;
    }

    private visitProgramFactors(
        program: FlexProgram,
        visitor: FlexProjectionFactorVisitor,
        removedEmissionIndex?: number,
        initialDenominator: bigint = 1n
    ): void {
        const visit = (
            emissionIndex: number,
            combo: PackedCombo,
            count: number,
            numerator: bigint,
            denominator: bigint,
            matchesTargetClue: boolean
        ): void => {
            if (emissionIndex >= program.length) {
                visitor(combo, count, numerator, denominator, matchesTargetClue);
                return;
            }

            if (emissionIndex === removedEmissionIndex) {
                visit(emissionIndex + 1, combo, count, numerator, denominator, matchesTargetClue);
                return;
            }

            const emission = program[emissionIndex]!;
            if (emission.kind === 'fixed') {
                const packedIndex = this.enchantToIndex.get(emission.packedEnchant);
                visit(
                    emissionIndex + 1,
                    packedIndex === undefined ? combo : appendPackedComboIndex(combo, packedIndex, count),
                    packedIndex === undefined ? count : count + 1,
                    numerator,
                    denominator,
                    matchesTargetClue || emission.packedEnchant === this.options.targetClueId
                );
                return;
            }

            const totalWeight = BigInt(emission.totalWeight);
            for (const alternative of emission.alternatives) {
                const packedIndex = this.enchantToIndex.get(alternative.packedEnchant);
                visit(
                    emissionIndex + 1,
                    packedIndex === undefined ? combo : appendPackedComboIndex(combo, packedIndex, count),
                    packedIndex === undefined ? count : count + 1,
                    numerator * BigInt(alternative.weight),
                    denominator * totalWeight,
                    matchesTargetClue || alternative.packedEnchant === this.options.targetClueId
                );
            }
        };

        visit(0, 0 as PackedCombo, 0, 1n, initialDenominator, false);
    }

    private addPendingProgramAggregate(
        pendingAggregates: MutablePendingFrontierAggregates,
        programId: FlexProgramId,
        mass: bigint,
        count: number
    ): void {
        if (mass <= 0n) return;

        const displayCount = this.options.applyBookRemoval && count > 1 ? count - 1 : count;
        addArrayMass(pendingAggregates.count, displayCount, mass);
        if (count <= 0) return;

        const clueQuotient = mass / BigInt(count);
        const clueRemainder = Number(mass % BigInt(count));

        const programLength = this.programs.writeProgramEmissions(programId, this.pendingProgramScratch);
        for (let emissionIndex = 0; emissionIndex < programLength; emissionIndex++) {
            const emission = this.pendingProgramScratch[emissionIndex]!;
            const clueSlotMass = clueQuotient + (emissionIndex < clueRemainder ? 1n : 0n);

            if (emission.kind === 'fixed') {
                this.addPendingEmissionAggregate(
                    pendingAggregates,
                    emission.packedEnchant,
                    mass,
                    clueSlotMass,
                    count
                );
                continue;
            }

            const totalWeight = BigInt(emission.totalWeight);
            for (const alternative of emission.alternatives) {
                this.addPendingEmissionAggregate(
                    pendingAggregates,
                    alternative.packedEnchant,
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
            pendingAggregates.shownClueDistribution.set(
                packedEnchant,
                (pendingAggregates.shownClueDistribution.get(packedEnchant) ?? 0n) + clueMass
            );
        }
    }

    private addPendingClueJointAggregate(
        clueJoint: MutablePendingClueJointAggregates,
        programId: FlexProgramId,
        clueMass: bigint,
        count: number
    ): void {
        if (clueMass <= 0n) return;

        clueJoint.knownSpace += clueMass;
        const displayCount = this.options.applyBookRemoval && count > 1 ? count - 1 : count;
        addArrayMass(clueJoint.count, displayCount, clueMass);

        const targetClueId = clueJoint.targetClueId;
        const programLength = this.programs.writeProgramEmissions(programId, this.pendingProgramScratch);
        for (let emissionIndex = 0; emissionIndex < programLength; emissionIndex++) {
            const emission = this.pendingProgramScratch[emissionIndex]!;
            if (emission.kind === 'fixed') {
                this.addPendingClueJointEmissionAggregate(clueJoint, emission.packedEnchant, clueMass, count);
                continue;
            }

            const targetAlternative = emission.alternatives.find(alternative => alternative.packedEnchant === targetClueId);
            if (targetAlternative) {
                this.addPendingClueJointEmissionAggregate(clueJoint, targetClueId, clueMass, count);
                continue;
            }

            const totalWeight = BigInt(emission.totalWeight);
            for (const alternative of emission.alternatives) {
                this.addPendingClueJointEmissionAggregate(
                    clueJoint,
                    alternative.packedEnchant,
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
    pendingAggregates: MutablePendingFrontierAggregates,
    clueJoint?: MutablePendingClueJointAggregates | undefined
): PendingFrontierAggregates {
    return Object.freeze({
        any: Object.freeze(pendingAggregates.any.slice()),
        ranks: Object.freeze(pendingAggregates.ranks.slice()),
        count: Object.freeze(pendingAggregates.count.slice()),
        shownClueDistribution: new Map(pendingAggregates.shownClueDistribution),
        ...(clueJoint ? { clueJoint: freezePendingClueJointAggregates(clueJoint) } : {})
    });
}

function freezePendingClueJointAggregates(clueJoint: MutablePendingClueJointAggregates): PendingClueJointAggregates {
    return Object.freeze({
        targetClueId: clueJoint.targetClueId,
        knownSpace: clueJoint.knownSpace,
        any: Object.freeze(clueJoint.any.slice()),
        ranks: Object.freeze(clueJoint.ranks.slice()),
        count: Object.freeze(clueJoint.count.slice())
    });
}

function addArrayMass(target: bigint[], key: number, mass: bigint): void {
    target[key] = (target[key] ?? 0n) + mass;
}
