import type { PackedCombo } from '#types/index.js';
import { PACKING_CONSTANTS } from '#constants/engine.js';
import type { PendingClueJointAggregates, PendingFrontierAggregates } from '#lib/search/SearchSnapshot.js';
import type {
    FlexPendingEntry,
    FlexPoolProfileId,
    FlexProgram,
    FlexProjectedPendingAggregateResults,
    FlexProgramId,
    FlexResultId
} from '#lib/search/flex/FlexTypes.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';
import { FlexPoolProfileStore } from '#lib/search/flex/FlexPoolProfileStore.js';
import { FlexResultKeyStore } from '#lib/search/flex/FlexResultKeyStore.js';

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
    poolProfileId: FlexPoolProfileId,
    mass: bigint,
    count: number,
    targetClueReachable?: boolean | undefined
) => void;

export interface FlexLazyPendingAggregateOptions {
    readonly onBuild?: (() => void) | undefined;
}

export interface FlexProjectionOptions {
    readonly applyBookRemoval?: boolean | undefined;
    readonly targetClueId?: number | undefined;
    readonly poolProfiles: FlexPoolProfileStore;
    readonly resultKeys: FlexResultKeyStore;
}

export class FlexProjector {
    public constructor(
        private readonly programs: FlexProgramStore,
        private readonly enchantToIndex: Map<number, number>,
        private readonly options: FlexProjectionOptions
    ) {}

    private readonly concreteProgramScratch: number[] = [];

    public projectResults(results: ReadonlyMap<FlexResultId, bigint>): {
        readonly results: ReadonlyMap<PackedCombo, bigint>;
        readonly projectionLoss: bigint;
        readonly clueIncompatible: bigint;
        readonly projectedMass: bigint;
        readonly sourceMass: bigint;
    } {
        const projected = new Map<PackedCombo, bigint>();
        let sourceMass = 0n;
        let projectedMass = 0n;
        let projectionLoss = 0n;
        let clueIncompatible = 0n;

        for (const [resultId, mass] of results) {
            sourceMass += mass;
            const key = this.options.resultKeys.get(resultId);

            let assigned = 0n;
            this.visitResultProgramFactors(key.programId, key.poolProfileId, (combo, _count, numerator, denominator, matchesTargetClue) => {
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

    public visitResultProgramFactors(
        programId: FlexProgramId,
        poolProfileId: FlexPoolProfileId,
        visitor: FlexResultProjectionFactorVisitor
    ): void {
        this.forEachResultProgramFactor(this.programs.getProgram(programId), poolProfileId, visitor);
    }

    public visitResultKeyFactors(resultId: FlexResultId, visitor: FlexResultProjectionFactorVisitor): void {
        const key = this.options.resultKeys.get(resultId);
        this.visitResultProgramFactors(key.programId, key.poolProfileId, visitor);
    }

    public isResultClueCompatible(matchesTargetClue: boolean): boolean {
        return this.isClueCompatible(matchesTargetClue);
    }

    public projectPendingAggregates(entries: readonly FlexPendingEntry[]): FlexProjectedPendingAggregateResults {
        return this.projectPendingAggregatesFromCursor(visitor => {
            for (const entry of entries) {
                visitor(entry.programId, entry.poolProfileId, entry.mass, entry.count, entry.targetClueReachable);
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

        visitEntries((programId, poolProfileId, mass, count, targetClueReachable) => {
            sourceMass += mass;
            if (mass === 0n) return;

            if (clueJoint) {
                const split = this.getPendingClueSplit(programId, poolProfileId, mass, count, targetClueReachable);
                projectedMass += split.projectedMass;
                clueIncompatible += split.clueIncompatible;
                projectionLoss += split.projectionLoss;

                if (split.clueKnownSpace > 0n) {
                    pendingAggregates.shownClueDistribution.set(
                        clueJoint.targetClueId,
                        (pendingAggregates.shownClueDistribution.get(clueJoint.targetClueId) ?? 0n) + split.clueKnownSpace
                    );
                    this.addPendingClueJointAggregate(clueJoint, programId, poolProfileId, split.clueKnownSpace, count);
                }
                return;
            }

            projectedMass += mass;
            this.addPendingProgramAggregate(
                pendingAggregates,
                programId,
                poolProfileId,
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

    public projectPendingLazyAggregatesFromCursor(
        visitEntries: (visitor: FlexPendingAggregateVisitor) => void,
        options: FlexLazyPendingAggregateOptions = {}
    ): FlexProjectedPendingAggregateResults {
        const captured: CapturedPendingAggregateEntries = {
            programIds: [],
            poolProfileIds: [],
            masses: [],
            counts: []
        };
        const targetClueId = this.options.targetClueId;
        const clueKnownSpaces = targetClueId === undefined ? undefined : [] as bigint[];
        if (clueKnownSpaces) captured.clueKnownSpaces = clueKnownSpaces;

        let sourceMass = 0n;
        let projectedMass = 0n;
        let projectionLoss = 0n;
        let clueIncompatible = 0n;

        visitEntries((programId, poolProfileId, mass, count, targetClueReachable) => {
            captured.programIds.push(programId);
            captured.poolProfileIds.push(poolProfileId);
            captured.masses.push(mass);
            captured.counts.push(count);

            sourceMass += mass;
            if (targetClueId === undefined) {
                projectedMass += mass;
                return;
            }

            if (mass === 0n) {
                clueKnownSpaces!.push(0n);
                return;
            }

            const split = this.getPendingClueSplit(programId, poolProfileId, mass, count, targetClueReachable);
            projectedMass += split.projectedMass;
            clueIncompatible += split.clueIncompatible;
            projectionLoss += split.projectionLoss;
            clueKnownSpaces!.push(split.clueKnownSpace);
        });

        return Object.freeze({
            pendingAggregates: createLazyPendingAggregates(
                () => this.buildCapturedPendingAggregates(captured),
                targetClueId !== undefined,
                options.onBuild
            ),
            projectionLoss,
            clueIncompatible,
            projectedMass,
            sourceMass
        });
    }

    private getPendingClueSplit(
        programId: FlexProgramId,
        poolProfileId: FlexPoolProfileId,
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

        let targetMass = 0n;
        let nonTargetMass = 0n;
        let assignedMass = 0n;

        this.visitConcreteProgramFactors(this.programs.getProgram(programId), poolProfileId, (packedEnchants, numerator, denominator) => {
            const share = (mass * numerator) / denominator;
            assignedMass += share;
            if (packedEnchants.includes(targetClueId)) targetMass += share;
            else nonTargetMass += share;
        });

        const nonTargetCanStillReachClue = targetClueReachable === true;
        return {
            projectedMass: targetMass + (nonTargetCanStillReachClue ? nonTargetMass : 0n),
            clueIncompatible: nonTargetCanStillReachClue ? 0n : nonTargetMass,
            projectionLoss: mass - assignedMass,
            clueKnownSpace: count > 0 ? targetMass / BigInt(count) : 0n
        };
    }

    private forEachResultProgramFactor(
        program: FlexProgram,
        poolProfileId: FlexPoolProfileId,
        visitor: FlexProjectionFactorVisitor
    ): void {
        if (this.options.applyBookRemoval && program.length >= 2) {
            const slotDenominator = BigInt(program.length);
            for (let removedEmissionIndex = 0; removedEmissionIndex < program.length; removedEmissionIndex++) {
                this.visitProgramFactors(program, poolProfileId, visitor, removedEmissionIndex, slotDenominator);
            }
            return;
        }

        this.visitProgramFactors(program, poolProfileId, visitor);
    }

    private isClueCompatible(matchesTargetClue: boolean): boolean {
        return this.options.targetClueId === undefined || matchesTargetClue;
    }

    private visitProgramFactors(
        program: FlexProgram,
        poolProfileId: FlexPoolProfileId,
        visitor: FlexProjectionFactorVisitor,
        removedEmissionIndex?: number,
        initialDenominator: bigint = 1n
    ): void {
        const profile = this.options.poolProfiles.get(poolProfileId);
        const visit = (
            sourceIndex: number,
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
                visit(sourceIndex, emissionIndex + 1, combo, count, numerator, denominator, matchesTargetClue);
                return;
            }

            const emission = program[emissionIndex]!;
            if (emission.kind === 'fixed' || emission.kind === 'rank') {
                const packedEnchant = this.options.poolProfiles.getPackedEnchant(poolProfileId, emission.enchantId, sourceIndex);
                const packedIndex = this.enchantToIndex.get(packedEnchant);
                visit(
                    sourceIndex,
                    emissionIndex + 1,
                    packedIndex === undefined ? combo : appendPackedComboIndex(combo, packedIndex, count),
                    packedIndex === undefined ? count : count + 1,
                    numerator,
                    denominator,
                    matchesTargetClue || packedEnchant === this.options.targetClueId
                );
                return;
            }

            const totalWeight = BigInt(emission.totalWeight);
            for (const alternative of emission.alternatives) {
                const packedEnchant = this.options.poolProfiles.getPackedEnchant(poolProfileId, alternative.enchantId, sourceIndex);
                const packedIndex = this.enchantToIndex.get(packedEnchant);
                visit(
                    sourceIndex,
                    emissionIndex + 1,
                    packedIndex === undefined ? combo : appendPackedComboIndex(combo, packedIndex, count),
                    packedIndex === undefined ? count : count + 1,
                    numerator * BigInt(alternative.weight),
                    denominator * totalWeight,
                    matchesTargetClue || packedEnchant === this.options.targetClueId
                );
            }
        };

        for (let sourceIndex = 0; sourceIndex < profile.sources.length; sourceIndex++) {
            const source = profile.sources[sourceIndex]!;
            visit(
                sourceIndex,
                0,
                0 as PackedCombo,
                0,
                source.profileWeight,
                initialDenominator * profile.totalWeight,
                false
            );
        }
    }

    private addPendingProgramAggregate(
        pendingAggregates: MutablePendingFrontierAggregates,
        programId: FlexProgramId,
        poolProfileId: FlexPoolProfileId,
        mass: bigint,
        count: number
    ): void {
        const displayCount = this.options.applyBookRemoval && count > 1 ? count - 1 : count;
        addArrayMass(pendingAggregates.count, displayCount, mass);
        if (count <= 0) return;

        this.visitConcreteProgramFactors(this.programs.getProgram(programId), poolProfileId, (packedEnchants, numerator, denominator) => {
            const share = (mass * numerator) / denominator;
            if (share <= 0n) return;
            const clueMass = share / BigInt(count);
            for (const packedEnchant of packedEnchants) {
                this.addPendingEmissionAggregate(pendingAggregates, packedEnchant, share, clueMass, count);
            }
        });
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
        poolProfileId: FlexPoolProfileId,
        clueMass: bigint,
        count: number
    ): void {
        clueJoint.knownSpace += clueMass;
        const displayCount = this.options.applyBookRemoval && count > 1 ? count - 1 : count;
        addArrayMass(clueJoint.count, displayCount, clueMass);

        let commonDenominator: bigint | undefined;
        let targetFactorNumerator = 0n;
        let denominatorMismatch = false;
        const matchingFactors: Array<readonly [readonly number[], bigint, bigint]> = [];
        this.visitConcreteProgramFactors(this.programs.getProgram(programId), poolProfileId, (packedEnchants, numerator, denominator) => {
            if (!packedEnchants.includes(clueJoint.targetClueId)) return;
            matchingFactors.push(Object.freeze([Object.freeze([...packedEnchants]), numerator, denominator]));
            if (commonDenominator === undefined) {
                commonDenominator = denominator;
            } else if (commonDenominator !== denominator) {
                denominatorMismatch = true;
            }
            targetFactorNumerator += numerator;
        });

        for (const [packedEnchants, numerator, denominator] of matchingFactors) {
            const share = !denominatorMismatch && targetFactorNumerator > 0n
                ? (clueMass * numerator) / targetFactorNumerator
                : (clueMass * numerator) / denominator;
            for (const packedEnchant of packedEnchants) {
                this.addPendingClueJointEmissionAggregate(clueJoint, packedEnchant, share, count);
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

    private buildCapturedPendingAggregates(captured: CapturedPendingAggregateEntries): PendingFrontierAggregates {
        const pendingAggregates = createPendingAggregates();
        const targetClueId = this.options.targetClueId;
        const clueJoint = targetClueId === undefined
            ? undefined
            : createPendingClueJointAggregates(targetClueId);

        for (let index = 0; index < captured.programIds.length; index++) {
            const programId = captured.programIds[index]!;
            const poolProfileId = captured.poolProfileIds[index]!;
            const mass = captured.masses[index]!;
            const count = captured.counts[index]!;
            if (mass <= 0n) continue;

            if (clueJoint) {
                const clueKnownSpace = captured.clueKnownSpaces?.[index] ?? 0n;
                if (clueKnownSpace > 0n) {
                    pendingAggregates.shownClueDistribution.set(
                        clueJoint.targetClueId,
                        (pendingAggregates.shownClueDistribution.get(clueJoint.targetClueId) ?? 0n) + clueKnownSpace
                    );
                    this.addPendingClueJointAggregate(clueJoint, programId, poolProfileId, clueKnownSpace, count);
                }
                continue;
            }

            this.addPendingProgramAggregate(
                pendingAggregates,
                programId,
                poolProfileId,
                mass,
                count
            );
        }

        return freezePendingAggregates(pendingAggregates, clueJoint);
    }

    private visitConcreteProgramFactors(
        program: FlexProgram,
        poolProfileId: FlexPoolProfileId,
        visitor: (packedEnchants: readonly number[], numerator: bigint, denominator: bigint) => void
    ): void {
        const profile = this.options.poolProfiles.get(poolProfileId);
        const packedScratch = this.concreteProgramScratch;
        packedScratch.length = 0;

        const visit = (
            sourceIndex: number,
            emissionIndex: number,
            numerator: bigint,
            denominator: bigint
        ): void => {
            if (emissionIndex >= program.length) {
                visitor(packedScratch, numerator, denominator);
                return;
            }

            const emission = program[emissionIndex]!;
            if (emission.kind === 'fixed' || emission.kind === 'rank') {
                packedScratch.push(this.options.poolProfiles.getPackedEnchant(poolProfileId, emission.enchantId, sourceIndex));
                visit(sourceIndex, emissionIndex + 1, numerator, denominator);
                packedScratch.pop();
                return;
            }

            const totalWeight = BigInt(emission.totalWeight);
            for (const alternative of emission.alternatives) {
                packedScratch.push(this.options.poolProfiles.getPackedEnchant(poolProfileId, alternative.enchantId, sourceIndex));
                visit(
                    sourceIndex,
                    emissionIndex + 1,
                    numerator * BigInt(alternative.weight),
                    denominator * totalWeight
                );
                packedScratch.pop();
            }
        };

        for (let sourceIndex = 0; sourceIndex < profile.sources.length; sourceIndex++) {
            const source = profile.sources[sourceIndex]!;
            visit(sourceIndex, 0, source.profileWeight, profile.totalWeight);
        }
    }
}

interface CapturedPendingAggregateEntries {
    readonly programIds: FlexProgramId[];
    readonly poolProfileIds: FlexPoolProfileId[];
    readonly masses: bigint[];
    readonly counts: number[];
    clueKnownSpaces?: bigint[] | undefined;
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

function createLazyPendingAggregates(
    build: () => PendingFrontierAggregates,
    includeClueJoint: boolean,
    onBuild?: (() => void) | undefined
): PendingFrontierAggregates {
    let cached: PendingFrontierAggregates | undefined;
    const get = (): PendingFrontierAggregates => {
        if (!cached) {
            onBuild?.();
            cached = build();
        }
        return cached;
    };
    const lazy: Partial<PendingFrontierAggregates> = {};
    Object.defineProperties(lazy, {
        any: {
            enumerable: true,
            get: () => get().any
        },
        ranks: {
            enumerable: true,
            get: () => get().ranks
        },
        count: {
            enumerable: true,
            get: () => get().count
        },
        shownClueDistribution: {
            enumerable: true,
            get: () => get().shownClueDistribution
        },
        ...(includeClueJoint
            ? {
                clueJoint: {
                    enumerable: true,
                    get: () => get().clueJoint
                }
            }
            : {})
    });
    return Object.freeze(lazy) as PendingFrontierAggregates;
}
