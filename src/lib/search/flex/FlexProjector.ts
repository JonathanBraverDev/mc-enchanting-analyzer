import type { PackedCombo } from '#types/index.js';
import { ComboUtils } from '#utils/index.js';
import type {
    FlexPendingEntry,
    FlexProgram,
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

    public projectResults(results: ReadonlyMap<FlexProgramId, bigint>): FlexProjectedResults {
        const projected = new Map<PackedCombo, bigint>();
        let sourceMass = 0n;
        let projectedMass = 0n;
        let projectionLoss = 0n;
        let clueIncompatible = 0n;

        for (const [programId, mass] of results) {
            const program = this.programs.getProgram(programId);
            sourceMass += mass;

            let assigned = 0n;
            this.forEachResultProgramFactor(program, (combo, _count, numerator, denominator, matchesTargetClue) => {
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
                pendingEntries.push(Object.freeze({
                    graphId: entry.graphId,
                    nodeId: entry.nodeId,
                    mass: share,
                    combo,
                    count
                }));
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
                    packedIndex === undefined ? combo : ComboUtils.packAppendIndex(combo, packedIndex, count),
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
                    packedIndex === undefined ? combo : ComboUtils.packAppendIndex(combo, packedIndex, count),
                    packedIndex === undefined ? count : count + 1,
                    numerator * BigInt(alternative.weight),
                    denominator * totalWeight,
                    matchesTargetClue || alternative.packedEnchant === this.options.targetClueId
                );
            }
        };

        visit(0, 0 as PackedCombo, 0, 1n, initialDenominator, false);
    }
}
