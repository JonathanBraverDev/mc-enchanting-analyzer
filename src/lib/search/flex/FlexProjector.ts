import type { PackedCombo } from '#types/index.js';
import { PACKING_CONSTANTS } from '#constants/engine.js';
import type { PendingClueJointAggregates, PendingFrontierAggregates } from '#lib/search/SearchSnapshot.js';
import type {
    FlexPendingEntry,
    FlexProgram,
    FlexProjectedPendingAggregateResults,
    FlexProgramId,
    FlexRankProfile,
    FlexRankProfileId
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

export interface FlexLazyPendingAggregateOptions {
    readonly onBuild?: (() => void) | undefined;
}

export interface FlexProjectionOptions {
    readonly applyBookRemoval?: boolean | undefined;
    readonly targetClueId?: number | undefined;
    readonly rankProfiles?: FlexRankProfileLookup | undefined;
}

export interface FlexRankProfileLookup {
    get(id: FlexRankProfileId): FlexRankProfile;
}

export class FlexProjector {
    public constructor(
        private readonly programs: FlexProgramStore,
        private readonly enchantToIndex: Map<number, number>,
        private readonly options: FlexProjectionOptions = {}
    ) {}

    private readonly pendingProgramScratch: FlexProgram[number][] = [];
    private readonly concreteProgramScratch: number[] = [];

    public projectResults(results: ReadonlyMap<FlexProgramId, bigint>): {
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

    public projectPendingLazyAggregatesFromCursor(
        visitEntries: (visitor: FlexPendingAggregateVisitor) => void,
        options: FlexLazyPendingAggregateOptions = {}
    ): FlexProjectedPendingAggregateResults {
        const captured: CapturedPendingAggregateEntries = {
            programIds: [],
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

        visitEntries((programId, mass, count, targetClueReachable) => {
            captured.programIds.push(programId);
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

            const split = this.getPendingClueSplit(programId, mass, count, targetClueReachable);
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
        if (this.programs.hasRankMerge(programId)) {
            return this.getRankPendingClueSplit(programId, mass, count, targetClueReachable);
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
            if (emission.kind === 'rank') continue;

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

    private visitProgramFactors(
        program: FlexProgram,
        visitor: FlexProjectionFactorVisitor,
        removedEmissionIndex?: number,
        initialDenominator: bigint = 1n
    ): void {
        const assignedProfileSources = new Map<number, number>();
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

            if (emission.kind === 'rank') {
                const profile = this.getRankProfile(emission.profileId);
                const profileKey = emission.profileId as number;
                const assignedSourceIndex = assignedProfileSources.get(profileKey);
                if (assignedSourceIndex !== undefined) {
                    const packedEnchant = getProfilePackedEnchant(profile, emission.enchantId, assignedSourceIndex);
                    const packedIndex = this.enchantToIndex.get(packedEnchant);
                    visit(
                        emissionIndex + 1,
                        packedIndex === undefined ? combo : appendPackedComboIndex(combo, packedIndex, count),
                        packedIndex === undefined ? count : count + 1,
                        numerator,
                        denominator,
                        matchesTargetClue || packedEnchant === this.options.targetClueId
                    );
                    return;
                }

                const totalWeight = profile.totalWeight;
                for (let sourceIndex = 0; sourceIndex < profile.sources.length; sourceIndex++) {
                    const source = profile.sources[sourceIndex]!;
                    const packedEnchant = getProfilePackedEnchant(profile, emission.enchantId, sourceIndex);
                    const packedIndex = this.enchantToIndex.get(packedEnchant);
                    assignedProfileSources.set(profileKey, sourceIndex);
                    visit(
                        emissionIndex + 1,
                        packedIndex === undefined ? combo : appendPackedComboIndex(combo, packedIndex, count),
                        packedIndex === undefined ? count : count + 1,
                        numerator * source.profileWeight,
                        denominator * totalWeight,
                        matchesTargetClue || packedEnchant === this.options.targetClueId
                    );
                    assignedProfileSources.delete(profileKey);
                }
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
        if (this.programs.hasRankMerge(programId)) {
            this.addRankPendingProgramAggregate(pendingAggregates, programId, mass, count);
            return;
        }

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
            if (emission.kind === 'rank') continue;

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
        if (this.programs.hasRankMerge(programId)) {
            this.addRankPendingClueJointAggregate(clueJoint, programId, clueMass, count);
            return;
        }

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
            if (emission.kind === 'rank') continue;

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

    private getRankPendingClueSplit(
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
        let targetMass = 0n;
        let nonTargetMass = 0n;
        let assignedMass = 0n;

        this.visitConcreteProgramFactors(this.programs.getProgram(programId), (packedEnchants, numerator, denominator) => {
            const share = (mass * numerator) / denominator;
            assignedMass += share;
            if (packedEnchants.includes(this.options.targetClueId!)) targetMass += share;
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

    private addRankPendingProgramAggregate(
        pendingAggregates: MutablePendingFrontierAggregates,
        programId: FlexProgramId,
        mass: bigint,
        count: number
    ): void {
        const displayCount = this.options.applyBookRemoval && count > 1 ? count - 1 : count;
        addArrayMass(pendingAggregates.count, displayCount, mass);
        if (count <= 0) return;

        this.visitConcreteProgramFactors(this.programs.getProgram(programId), (packedEnchants, numerator, denominator) => {
            const share = (mass * numerator) / denominator;
            if (share <= 0n) return;
            const clueMass = share / BigInt(count);
            for (const packedEnchant of packedEnchants) {
                this.addPendingEmissionAggregate(pendingAggregates, packedEnchant, share, clueMass, count);
            }
        });
    }

    private addRankPendingClueJointAggregate(
        clueJoint: MutablePendingClueJointAggregates,
        programId: FlexProgramId,
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
        this.visitConcreteProgramFactors(this.programs.getProgram(programId), (packedEnchants, numerator, denominator) => {
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

    private buildCapturedPendingAggregates(captured: CapturedPendingAggregateEntries): PendingFrontierAggregates {
        const pendingAggregates = createPendingAggregates();
        const targetClueId = this.options.targetClueId;
        const clueJoint = targetClueId === undefined
            ? undefined
            : createPendingClueJointAggregates(targetClueId);

        for (let index = 0; index < captured.programIds.length; index++) {
            const programId = captured.programIds[index]!;
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
                    this.addPendingClueJointAggregate(clueJoint, programId, clueKnownSpace, count);
                }
                continue;
            }

            this.addPendingProgramAggregate(
                pendingAggregates,
                programId,
                mass,
                count
            );
        }

        return freezePendingAggregates(pendingAggregates, clueJoint);
    }

    private visitConcreteProgramFactors(
        program: FlexProgram,
        visitor: (packedEnchants: readonly number[], numerator: bigint, denominator: bigint) => void
    ): void {
        const assignedProfileSources = new Map<number, number>();
        const packedScratch = this.concreteProgramScratch;
        packedScratch.length = 0;

        const visit = (
            emissionIndex: number,
            numerator: bigint,
            denominator: bigint
        ): void => {
            if (emissionIndex >= program.length) {
                visitor(packedScratch, numerator, denominator);
                return;
            }

            const emission = program[emissionIndex]!;
            if (emission.kind === 'fixed') {
                packedScratch.push(emission.packedEnchant);
                visit(emissionIndex + 1, numerator, denominator);
                packedScratch.pop();
                return;
            }

            if (emission.kind === 'rank') {
                const profile = this.getRankProfile(emission.profileId);
                const profileKey = emission.profileId as number;
                const assignedSourceIndex = assignedProfileSources.get(profileKey);
                if (assignedSourceIndex !== undefined) {
                    packedScratch.push(getProfilePackedEnchant(profile, emission.enchantId, assignedSourceIndex));
                    visit(emissionIndex + 1, numerator, denominator);
                    packedScratch.pop();
                    return;
                }

                for (let sourceIndex = 0; sourceIndex < profile.sources.length; sourceIndex++) {
                    const source = profile.sources[sourceIndex]!;
                    assignedProfileSources.set(profileKey, sourceIndex);
                    packedScratch.push(getProfilePackedEnchant(profile, emission.enchantId, sourceIndex));
                    visit(
                        emissionIndex + 1,
                        numerator * source.profileWeight,
                        denominator * profile.totalWeight
                    );
                    packedScratch.pop();
                    assignedProfileSources.delete(profileKey);
                }
                return;
            }

            const totalWeight = BigInt(emission.totalWeight);
            for (const alternative of emission.alternatives) {
                packedScratch.push(alternative.packedEnchant);
                visit(
                    emissionIndex + 1,
                    numerator * BigInt(alternative.weight),
                    denominator * totalWeight
                );
                packedScratch.pop();
            }
        };

        visit(0, 1n, 1n);
    }

    private getRankProfile(profileId: FlexRankProfileId): FlexRankProfile {
        const rankProfiles = this.options.rankProfiles;
        if (rankProfiles === undefined) {
            throw new Error('Flex rank emission projection requires a rank profile store.');
        }
        return rankProfiles.get(profileId);
    }

}

interface CapturedPendingAggregateEntries {
    readonly programIds: FlexProgramId[];
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

function getProfilePackedEnchant(profile: FlexRankProfile, enchantId: number, sourceIndex: number): number {
    const enchant = profile.enchants.find(candidate => candidate.enchantId === enchantId);
    if (enchant === undefined) {
        throw new Error(`Rank profile ${String(profile.id)} does not include enchant ${String(enchantId)}.`);
    }
    const packedEnchant = enchant.sourcePackedEnchants[sourceIndex];
    if (packedEnchant === undefined) {
        throw new Error(`Rank profile ${String(profile.id)} does not include source ${String(sourceIndex)} for enchant ${String(enchantId)}.`);
    }
    return packedEnchant;
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
