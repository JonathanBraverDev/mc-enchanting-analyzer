import type { PackedCombo } from '#types/index.js';
import { ComboUtils } from '#utils/index.js';
import type {
    FlexPendingEntry,
    FlexProgram,
    FlexProjectedPendingEntry,
    FlexProjectedResults,
    FlexProgramId
} from '#lib/search/flex/FlexTypes.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';

interface FlexProjectionFactor {
    readonly combo: PackedCombo;
    readonly count: number;
    readonly numerator: bigint;
    readonly denominator: bigint;
}

export interface FlexProjectionOptions {
    readonly applyBookRemoval?: boolean | undefined;
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

        for (const [programId, mass] of results) {
            sourceMass += mass;
            let assigned = 0n;
            this.forEachResultProgramFactor(programId, (factor) => {
                const share = (mass * factor.numerator) / factor.denominator;
                assigned += share;
                if (share === 0n) return;
                projectedMass += share;
                if (factor.combo !== 0) {
                    projected.set(factor.combo, (projected.get(factor.combo) ?? 0n) + share);
                }
            });
            projectionLoss += mass - assigned;
        }

        return Object.freeze({
            results: new Map(projected),
            projectionLoss,
            projectedMass,
            sourceMass
        });
    }

    public projectPending(entries: readonly FlexPendingEntry[]): readonly FlexProjectedPendingEntry[] {
        const projected: FlexProjectedPendingEntry[] = [];
        for (const entry of entries) {
            this.forEachProgramFactor(entry.programId, (factor) => {
                const share = (entry.mass * factor.numerator) / factor.denominator;
                if (share === 0n) return;
                projected.push(Object.freeze({
                    graphId: entry.graphId,
                    nodeId: entry.nodeId,
                    mass: share,
                    combo: factor.combo,
                    count: factor.count
                }));
            });
        }
        return Object.freeze(projected);
    }

    private forEachResultProgramFactor(
        programId: FlexProgramId,
        visitor: (factor: FlexProjectionFactor) => void
    ): void {
        const program = this.programs.getProgram(programId);
        if (this.options.applyBookRemoval && program.length >= 2) {
            const slotDenominator = BigInt(program.length);
            for (let removedEmissionIndex = 0; removedEmissionIndex < program.length; removedEmissionIndex++) {
                this.visitProgramFactors(program, visitor, removedEmissionIndex, slotDenominator);
            }
            return;
        }

        this.visitProgramFactors(program, visitor);
    }

    private forEachProgramFactor(
        programId: FlexProgramId,
        visitor: (factor: FlexProjectionFactor) => void
    ): void {
        this.visitProgramFactors(this.programs.getProgram(programId), visitor);
    }

    private visitProgramFactors(
        program: FlexProgram,
        visitor: (factor: FlexProjectionFactor) => void,
        removedEmissionIndex?: number,
        initialDenominator: bigint = 1n
    ): void {
        const visit = (
            emissionIndex: number,
            combo: PackedCombo,
            count: number,
            numerator: bigint,
            denominator: bigint
        ): void => {
            if (emissionIndex >= program.length) {
                visitor(Object.freeze({ combo, count, numerator, denominator }));
                return;
            }

            if (emissionIndex === removedEmissionIndex) {
                visit(emissionIndex + 1, combo, count, numerator, denominator);
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
                    denominator
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
                    denominator * totalWeight
                );
            }
        };

        visit(0, 0 as PackedCombo, 0, 1n, initialDenominator);
    }
}
