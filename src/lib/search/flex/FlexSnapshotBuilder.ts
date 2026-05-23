import { ENGINE_FRONTIER_KIND, createFactorizedEngineFrontier, type ComboMassAggregates, type EngineSearchSnapshot, type FactorizedFrontierEntry, type PendingFrontierAggregates } from '#lib/search/SearchRun.js';
import { ProbabilityMassAccountant, PROJECTION_MASS_BUCKET, PROJECTION_MASS_OPERATION } from '#engine/search/ProbabilityMassAccountant.js';
import { PACKING_CONSTANTS } from '#constants/engine.js';
import type { MassAccountingBreakdown, MassAccountingDetailBucket, MassAccountingDetails, MassAccountingOperationDetails, MassAccountingStageDetails } from '#types/mass.js';
import { RESULT_COMBO_MODE, type PackedCombo, type PackedEnchant, type ResultComboMode } from '#types/index.js';
import { ComboUtils, ProbUtils } from '#utils/index.js';
import type { FlexCoordinator } from '#lib/search/flex/FlexCoordinator.js';
import type { FlexProgramId, FlexRunState } from '#lib/search/flex/FlexTypes.js';
import { FlexProjector } from '#lib/search/flex/FlexProjector.js';

type MutableComboMassAggregates = {
    any: bigint[];
    ranks: bigint[];
    count: bigint[];
    shownClueDistribution: Map<number, bigint>;
};

interface ProjectionTotals {
    sourceMass: bigint;
    projectedMass: bigint;
    clueIncompatible: bigint;
    projectionLoss: bigint;
}

export interface FlexNativeSnapshotOptions {
    readonly resultComboMode?: ResultComboMode | undefined;
    readonly materializeFactorizedFrontierEntries?: boolean | undefined;
}

export interface FlexNativeCheckpoint {
    readonly snapshot: EngineSearchSnapshot;
    readonly resolvedProjectionLoss: bigint;
    readonly pendingProjectionLoss: bigint;
    readonly projectionLoss: bigint;
    readonly resolvedClueIncompatible: bigint;
    readonly pendingClueIncompatible: bigint;
    readonly projectionClueIncompatible: bigint;
}

export class FlexSnapshotBuilder {
    private readonly aggregateProjectedMasses = new Map<FlexProgramId, bigint>();
    private readonly comboProjectedMasses = new Map<FlexProgramId, bigint>();
    private readonly comboRows = new Map<PackedCombo, bigint>();
    private readonly resolvedAggregates = createMutableComboMassAggregates();
    private readonly aggregateTotals: ProjectionTotals = {
        sourceMass: 0n,
        projectedMass: 0n,
        clueIncompatible: 0n,
        projectionLoss: 0n
    };
    private readonly comboTotals: ProjectionTotals = {
        sourceMass: 0n,
        projectedMass: 0n,
        clueIncompatible: 0n,
        projectionLoss: 0n
    };

    public constructor(
        private readonly coordinator: FlexCoordinator,
        private readonly projector: FlexProjector,
        private readonly indexToEnchant: readonly number[],
        private readonly getTargetClueReachable: (graphId: number, nodeId: number) => boolean | undefined
    ) {}

    public build(state: FlexRunState, options: FlexNativeSnapshotOptions = {}): FlexNativeCheckpoint {
        const resultComboMode = options.resultComboMode ?? RESULT_COMBO_MODE.EXACT;
        const includeCombos = resultComboMode === RESULT_COMBO_MODE.EXACT;
        this.refreshResolvedProjection(state.results, includeCombos);

        const pending = this.projectPending(options.materializeFactorizedFrontierEntries === true);
        const mass = this.createMass(state, this.aggregateTotals, pending);
        const pendingAggregates = state.pendingCount > 0 ? pending.pendingAggregates : undefined;
        const frontier = pendingAggregates
            ? createFactorizedEngineFrontier(pending.entries, pendingAggregates, state.pendingCount)
            : Object.freeze({ kind: ENGINE_FRONTIER_KIND.EMPTY } as const);
        const results = includeCombos ? new Map(this.comboRows) : new Map<PackedCombo, bigint>();
        const resolvedAggregates = freezeComboMassAggregates(this.resolvedAggregates);

        return Object.freeze({
            snapshot: Object.freeze({
                results,
                resolvedAggregates,
                mass,
                iterations: state.iterations,
                lastExpandedMass: state.lastExpandedMass,
                pendingCount: state.pendingCount,
                largestPendingMass: state.largestPendingMass,
                pendingEntries: Object.freeze([]),
                ...(pendingAggregates ? { pendingAggregates } : {}),
                frontier,
                graphCount: state.graphCount,
                seededLevelCount: state.graphCount,
                activeResidueCount: state.activeResidueCount,
                activeResidueMass: state.activeResidueMass,
                fullyResolved: state.fullyResolved,
                suffixMerging: Object.freeze({
                    enabled: false,
                    canonicalEntryCount: 0,
                    hits: 0,
                    misses: 0,
                    mergedPendingMass: 0n,
                    avoidedPendingEntries: 0
                })
            }),
            resolvedProjectionLoss: this.aggregateTotals.projectionLoss,
            pendingProjectionLoss: pending.projectionLoss,
            projectionLoss: this.aggregateTotals.projectionLoss + pending.projectionLoss,
            resolvedClueIncompatible: this.aggregateTotals.clueIncompatible,
            pendingClueIncompatible: pending.clueIncompatible,
            projectionClueIncompatible: this.aggregateTotals.clueIncompatible + pending.clueIncompatible
        });
    }

    private refreshResolvedProjection(results: ReadonlyMap<FlexProgramId, bigint>, includeCombos: boolean): void {
        for (const [programId, mass] of results) {
            const aggregatePrevious = this.aggregateProjectedMasses.get(programId) ?? 0n;
            const comboPrevious = includeCombos ? this.comboProjectedMasses.get(programId) ?? 0n : undefined;

            if (includeCombos && comboPrevious === aggregatePrevious) {
                this.projectResultProgramDelta(programId, aggregatePrevious, mass, true, true);
                this.aggregateProjectedMasses.set(programId, mass);
                this.comboProjectedMasses.set(programId, mass);
                continue;
            }

            this.projectResultProgramDelta(programId, aggregatePrevious, mass, true, false);
            this.aggregateProjectedMasses.set(programId, mass);

            if (includeCombos && comboPrevious !== undefined) {
                this.projectResultProgramDelta(programId, comboPrevious, mass, false, true);
                this.comboProjectedMasses.set(programId, mass);
            }
        }
    }

    private projectResultProgramDelta(
        programId: FlexProgramId,
        previousMass: bigint,
        currentMass: bigint,
        updateAggregates: boolean,
        updateCombos: boolean
    ): void {
        if (previousMass === currentMass) return;

        const totals = updateAggregates ? this.aggregateTotals : this.comboTotals;
        const sourceDelta = currentMass - previousMass;
        let assignedDelta = 0n;
        totals.sourceMass += sourceDelta;

        this.projector.visitResultProgramFactors(programId, (combo, count, numerator, denominator, matchesTargetClue) => {
            const currentShare = (currentMass * numerator) / denominator;
            const previousShare = (previousMass * numerator) / denominator;
            const shareDelta = currentShare - previousShare;
            assignedDelta += shareDelta;
            if (shareDelta === 0n) return;

            if (!this.isClueCompatible(matchesTargetClue)) {
                totals.clueIncompatible += shareDelta;
                return;
            }

            totals.projectedMass += shareDelta;
            if (updateAggregates) addComboAggregate(this.resolvedAggregates, combo, count, shareDelta, this.indexToEnchant);
            if (updateCombos && combo !== 0) addMapMass(this.comboRows, combo, shareDelta);
        });

        totals.projectionLoss += sourceDelta - assignedDelta;
    }

    private projectPending(materializeEntries: boolean): PendingProjection {
        const entries: FactorizedFrontierEntry[] = [];
        const projected = this.projector.projectPendingAggregatesFromCursor(visitor => {
            this.coordinator.forEachPending((graphId, nodeId, programId, mass, count, nodeKind) => {
                const targetClueReachable = this.getTargetClueReachable(graphId, nodeId as number);
                visitor(programId, mass, count, targetClueReachable);
                if (materializeEntries) {
                    entries.push(Object.freeze({
                        graphId,
                        nodeId: nodeId as number,
                        programId,
                        mass,
                        count,
                        nodeKind,
                        ...(targetClueReachable !== undefined ? { targetClueReachable } : {})
                    }));
                }
            });
        });

        return {
            ...projected,
            entries: Object.freeze(entries)
        };
    }

    private isClueCompatible(matchesTargetClue: boolean): boolean {
        return this.projector.isResultClueCompatible(matchesTargetClue);
    }

    private createMass(
        state: FlexRunState,
        resolved: ProjectionTotals,
        pending: PendingProjection
    ): MassAccountingBreakdown {
        const engine = state.mass.units;
        if (!engine) throw new Error('Cannot expose Flex checkpoint without precise engine accounting units.');

        const clueIncompatible = BigInt(engine.clueIncompatible) + resolved.clueIncompatible + pending.clueIncompatible;
        const rounding = BigInt(engine.rounding) + resolved.projectionLoss + pending.projectionLoss;
        const details = createMassDetails(state.massDetails, resolved, pending);
        const mass: MassAccountingBreakdown = {
            resolved: ProbUtils.toNumber(resolved.projectedMass),
            clueIncompatible: ProbUtils.toNumber(clueIncompatible),
            pending: ProbUtils.toNumber(pending.projectedMass),
            sieved: ProbUtils.toNumber(BigInt(engine.sieved)),
            overflow: ProbUtils.toNumber(BigInt(engine.overflow)),
            capped: ProbUtils.toNumber(BigInt(engine.capped)),
            rounding: ProbUtils.toNumber(rounding),
            recoveredRounding: ProbUtils.toNumber(BigInt(engine.recoveredRounding)),
            recoveredSieved: ProbUtils.toNumber(BigInt(engine.recoveredSieved)),
            units: Object.freeze({
                resolved: resolved.projectedMass.toString(),
                clueIncompatible: clueIncompatible.toString(),
                pending: pending.projectedMass.toString(),
                sieved: engine.sieved,
                overflow: engine.overflow,
                capped: engine.capped,
                rounding: rounding.toString(),
                recoveredRounding: engine.recoveredRounding,
                recoveredSieved: engine.recoveredSieved
            })
        };
        if (details) mass.details = details;
        return Object.freeze(mass);
    }
}

interface PendingProjection {
    readonly pendingAggregates: PendingFrontierAggregates;
    readonly entries: readonly FactorizedFrontierEntry[];
    readonly sourceMass: bigint;
    readonly projectedMass: bigint;
    readonly clueIncompatible: bigint;
    readonly projectionLoss: bigint;
}

function createMutableComboMassAggregates(): MutableComboMassAggregates {
    return {
        any: [],
        ranks: [],
        count: [],
        shownClueDistribution: new Map()
    };
}

function freezeComboMassAggregates(source: MutableComboMassAggregates): ComboMassAggregates {
    return Object.freeze({
        any: Object.freeze(source.any.slice()),
        ranks: Object.freeze(source.ranks.slice()),
        count: Object.freeze(source.count.slice()),
        shownClueDistribution: new Map(source.shownClueDistribution)
    });
}

function addComboAggregate(
    target: MutableComboMassAggregates,
    combo: PackedCombo,
    count: number,
    mass: bigint,
    indexToEnchant: readonly number[]
): void {
    if (mass === 0n || combo === 0 || count <= 0) return;

    addArrayMass(target.count, count, mass);
    const clueQuotient = mass / BigInt(count);
    const clueRemainder = Number(mass % BigInt(count));
    ComboUtils.forEachEnchant(combo, indexToEnchant as number[], (enchant: PackedEnchant, position: number) => {
        const id = enchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        addArrayMass(target.any, id, mass);
        addArrayMass(target.ranks, enchant, mass);

        const clueMass = clueQuotient + (position < clueRemainder ? 1n : 0n);
        if (clueMass !== 0n) addMapMass(target.shownClueDistribution, enchant, clueMass);
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

function createMassDetails(
    searchDetails: MassAccountingDetails | undefined,
    resolved: ProjectionTotals,
    pending: PendingProjection
): MassAccountingDetails | undefined {
    const details = cloneMassAccountingDetails(searchDetails);
    mergeMassAccountingDetails(details, createProjectionMassDetails(resolved, pending));
    return Object.keys(details.stages).length === 0 ? undefined : freezeMassAccountingDetails(details);
}

function createProjectionMassDetails(resolved: ProjectionTotals, pending: PendingProjection): MassAccountingDetails | undefined {
    const accountant = new ProbabilityMassAccountant();
    const results = accountant.forProjectionOperation(PROJECTION_MASS_OPERATION.Results);
    results.record(PROJECTION_MASS_BUCKET.Source, resolved.sourceMass);
    results.record(PROJECTION_MASS_BUCKET.Projected, resolved.projectedMass);
    results.record(PROJECTION_MASS_BUCKET.ClueIncompatible, resolved.clueIncompatible);
    results.record(PROJECTION_MASS_BUCKET.Loss, resolved.projectionLoss);

    const pendingOperation = accountant.forProjectionOperation(PROJECTION_MASS_OPERATION.Pending);
    pendingOperation.record(PROJECTION_MASS_BUCKET.Source, pending.sourceMass);
    pendingOperation.record(PROJECTION_MASS_BUCKET.Projected, pending.projectedMass);
    pendingOperation.record(PROJECTION_MASS_BUCKET.ClueIncompatible, pending.clueIncompatible);
    pendingOperation.record(PROJECTION_MASS_BUCKET.Loss, pending.projectionLoss);

    return accountant.toPublicDetails();
}

function cloneMassAccountingDetails(source: MassAccountingDetails | undefined): MassAccountingDetails {
    const stages: Record<string, MassAccountingStageDetails> = {};
    if (!source) return { stages };

    for (const [stageName, stage] of Object.entries(source.stages)) {
        const operations: Record<string, MassAccountingOperationDetails> = {};
        for (const [operationName, operation] of Object.entries(stage.operations)) {
            operations[operationName] = {
                buckets: cloneMassDetailBuckets(operation.buckets)
            };
        }

        stages[stageName] = {
            buckets: cloneMassDetailBuckets(stage.buckets),
            operations
        };
    }

    return { stages };
}

function cloneMassDetailBuckets(
    buckets: Record<string, MassAccountingDetailBucket>
): Record<string, MassAccountingDetailBucket> {
    const clone: Record<string, MassAccountingDetailBucket> = {};
    for (const [bucketName, bucket] of Object.entries(buckets)) {
        clone[bucketName] = { ...bucket };
    }
    return clone;
}

function mergeMassAccountingDetails(target: MassAccountingDetails, source: MassAccountingDetails | undefined): void {
    if (!source) return;

    for (const [stageName, sourceStage] of Object.entries(source.stages)) {
        const targetStage = target.stages[stageName] ?? {
            buckets: {},
            operations: {}
        };
        target.stages[stageName] = targetStage;
        mergeMassDetailBuckets(targetStage.buckets, sourceStage.buckets);

        for (const [operationName, sourceOperation] of Object.entries(sourceStage.operations)) {
            const targetOperation = targetStage.operations[operationName] ?? {
                buckets: {}
            };
            targetStage.operations[operationName] = targetOperation;
            mergeMassDetailBuckets(targetOperation.buckets, sourceOperation.buckets);
        }
    }
}

function mergeMassDetailBuckets(
    target: Record<string, MassAccountingDetailBucket>,
    source: Record<string, MassAccountingDetailBucket>
): void {
    for (const [bucketName, bucket] of Object.entries(source)) {
        const previousUnits = BigInt(target[bucketName]?.units ?? 0);
        target[bucketName] = toMassDetailBucket(previousUnits + BigInt(bucket.units));
    }
}

function toMassDetailBucket(units: bigint): MassAccountingDetailBucket {
    return {
        value: ProbUtils.toNumber(units),
        units: units.toString()
    };
}

function freezeMassAccountingDetails(details: MassAccountingDetails): MassAccountingDetails {
    for (const stage of Object.values(details.stages)) {
        for (const bucket of Object.values(stage.buckets)) Object.freeze(bucket);
        Object.freeze(stage.buckets);

        for (const operation of Object.values(stage.operations)) {
            for (const bucket of Object.values(operation.buckets)) Object.freeze(bucket);
            Object.freeze(operation.buckets);
            Object.freeze(operation);
        }

        Object.freeze(stage.operations);
        Object.freeze(stage);
    }

    Object.freeze(details.stages);
    return Object.freeze(details);
}
