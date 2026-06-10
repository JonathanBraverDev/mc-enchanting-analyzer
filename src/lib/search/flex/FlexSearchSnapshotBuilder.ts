import { ENGINE_FRONTIER_KIND, createFactorizedEngineFrontier, type ComboMassAggregates, type EngineSearchSnapshot, type FactorizedFrontierEntry, type PendingFrontierAggregates } from '#lib/search/SearchSnapshot.js';
import {
    ProbabilityMassAccountant,
    PROJECTION_MASS_BUCKET,
    PROJECTION_MASS_OPERATION,
    SEARCH_MASS_BUCKET,
    SEARCH_MASS_OPERATION
} from '#engine/search/ProbabilityMassAccountant.js';
import { BIGINT_CONSTANTS, PACKING_CONSTANTS } from '#constants/engine.js';
import type { MassAccountingBreakdown } from '#types/mass.js';
import type { PackedCombo, PackedEnchant } from '#types/index.js';
import { ComboUtils, ProbUtils } from '#utils/index.js';
import { FlexSearchProjector, type FlexSearchProjectionResult } from '#lib/search/flex/FlexSearchProjector.js';
import type { FlexSearchRun, FlexSearchRunState, FlexSearchRunMemoryStats } from '#lib/search/flex/FlexSearchRun.js';

type MutableComboMassAggregates = {
    any: bigint[];
    ranks: bigint[];
    count: bigint[];
    shownClueDistribution: Map<number, bigint>;
};

export interface FlexSearchNativeCheckpoint {
    readonly snapshot: EngineSearchSnapshot;
    readonly projectionLoss: bigint;
    readonly projectionClueIncompatible: bigint;
}

export class FlexSearchSnapshotBuilder {
    public constructor(
        private readonly run: FlexSearchRun,
        private readonly projector: FlexSearchProjector,
        private readonly indexToEnchant: readonly number[]
    ) {}

    public build(state: FlexSearchRunState = this.run.state()): FlexSearchNativeCheckpoint {
        const memory = this.run.getMemoryStats();
        const projection = this.projector.projectResults(this.run.getResolvedEntries());
        const pending = this.projectPending(state);
        const resolvedAggregates = aggregateProjectedResults(projection.results, this.indexToEnchant);
        const pendingAggregates = state.pendingCount > 0 ? pending.pendingAggregates : undefined;
        const frontier = pendingAggregates
            ? createFactorizedEngineFrontier(pending.entries, pendingAggregates, state.pendingCount)
            : Object.freeze({ kind: ENGINE_FRONTIER_KIND.EMPTY } as const);

        return Object.freeze({
            snapshot: Object.freeze({
                results: new Map(projection.results),
                resolvedAggregates,
                mass: createMass(memory, projection, pending),
                iterations: state.iterations,
                lastExpandedMass: state.lastExpandedMass,
                pendingCount: state.pendingCount,
                largestPendingMass: state.largestPendingMass,
                pendingEntries: Object.freeze([]),
                ...(pendingAggregates ? { pendingAggregates } : {}),
                frontier,
                graphCount: state.graphCount,
                seededLevelCount: state.seededLevelCount,
                activeResidueCount: state.activeResidueCount,
                activeResidueMass: state.activeResidueMass,
                fullyResolved: state.fullyResolved
            }),
            projectionLoss: projection.projectionLoss,
            projectionClueIncompatible: projection.clueIncompatible
        });
    }

    private projectPending(state: FlexSearchRunState): PendingProjection {
        if (state.pendingCount === 0) {
            return {
                pendingAggregates: EMPTY_PENDING_AGGREGATES,
                entries: EMPTY_FACTORIZED_FRONTIER_ENTRIES,
                sourceMass: 0n,
                projectedMass: 0n,
                clueIncompatible: 0n,
                projectionLoss: 0n
            };
        }

        return {
            ...this.projector.projectPendingAggregates(this.getPendingProjectionEntries()),
            entries: EMPTY_FACTORIZED_FRONTIER_ENTRIES
        };
    }

    private getPendingProjectionEntries() {
        const targetClueId = this.projector.options.targetClueId;
        if (targetClueId === undefined) return this.run.getPendingEntries();

        const targetEnchantId = targetClueId >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        const targetBit = BIGINT_CONSTANTS.ID_BIT_LOOKUP[targetEnchantId];
        if (targetBit === undefined) return this.run.getPendingEntries();

        return this.run.getPendingEntries().map(entry => {
            const node = this.run.getGraph(entry.graphId).getNode(entry.nodeId);
            return Object.freeze({
                ...entry,
                targetClueReachable: (node.exclusionMask & targetBit) === 0n
            });
        });
    }
}

function createMass(
    memory: FlexSearchRunMemoryStats,
    projection: FlexSearchProjectionResult,
    pending: PendingProjection
): MassAccountingBreakdown {
    const rounding = memory.roundingLoss + projection.projectionLoss + pending.projectionLoss;
    const details = createMassDetails(memory, projection, pending);
    return Object.freeze({
        resolved: ProbUtils.toNumber(projection.projectedMass),
        clueIncompatible: ProbUtils.toNumber(projection.clueIncompatible + pending.clueIncompatible),
        pending: ProbUtils.toNumber(pending.projectedMass),
        sieved: ProbUtils.toNumber(memory.sievedMass),
        overflow: ProbUtils.toNumber(memory.overflowMass),
        capped: 0,
        rounding: ProbUtils.toNumber(rounding),
        recoveredRounding: 0,
        recoveredSieved: 0,
        units: Object.freeze({
            resolved: projection.projectedMass.toString(),
            clueIncompatible: (projection.clueIncompatible + pending.clueIncompatible).toString(),
            pending: pending.projectedMass.toString(),
            sieved: memory.sievedMass.toString(),
            overflow: memory.overflowMass.toString(),
            capped: '0',
            rounding: rounding.toString(),
            recoveredRounding: '0',
            recoveredSieved: '0'
        }),
        ...(details ? { details } : {})
    });
}

function createMassDetails(
    memory: FlexSearchRunMemoryStats,
    projection: FlexSearchProjectionResult,
    pending: PendingProjection
): MassAccountingBreakdown['details'] {
    const accountant = new ProbabilityMassAccountant();
    accountant.recordSearch(SEARCH_MASS_OPERATION.Seed, SEARCH_MASS_BUCKET.Pending, memory.seededMass);
    accountant.recordSearch(SEARCH_MASS_OPERATION.Frontier, SEARCH_MASS_BUCKET.Pending, pending.sourceMass - memory.seededMass);
    accountant.recordSearch(SEARCH_MASS_OPERATION.Resolve, SEARCH_MASS_BUCKET.Resolved, memory.resolvedMass);
    accountant.recordSearch(SEARCH_MASS_OPERATION.ProbabilityFloor, SEARCH_MASS_BUCKET.Sieved, memory.sievedMass);
    accountant.recordSearch(SEARCH_MASS_OPERATION.Overflow, SEARCH_MASS_BUCKET.Overflow, memory.overflowMass);
    accountant.recordSearch(SEARCH_MASS_OPERATION.EdgeSplit, SEARCH_MASS_BUCKET.Rounding, memory.roundingLoss);

    const results = accountant.forProjectionOperation(PROJECTION_MASS_OPERATION.Results);
    results.record(PROJECTION_MASS_BUCKET.Source, projection.sourceMass);
    results.record(PROJECTION_MASS_BUCKET.Projected, projection.projectedMass);
    results.record(PROJECTION_MASS_BUCKET.ClueIncompatible, projection.clueIncompatible);
    results.record(PROJECTION_MASS_BUCKET.Loss, projection.projectionLoss);

    const pendingOperation = accountant.forProjectionOperation(PROJECTION_MASS_OPERATION.Pending);
    pendingOperation.record(PROJECTION_MASS_BUCKET.Source, pending.sourceMass);
    pendingOperation.record(PROJECTION_MASS_BUCKET.Projected, pending.projectedMass);
    pendingOperation.record(PROJECTION_MASS_BUCKET.ClueIncompatible, pending.clueIncompatible);
    pendingOperation.record(PROJECTION_MASS_BUCKET.Loss, pending.projectionLoss);

    return accountant.toPublicDetails();
}

interface PendingProjection {
    readonly pendingAggregates: PendingFrontierAggregates;
    readonly entries: readonly FactorizedFrontierEntry[];
    readonly sourceMass: bigint;
    readonly projectedMass: bigint;
    readonly clueIncompatible: bigint;
    readonly projectionLoss: bigint;
}

const EMPTY_FACTORIZED_FRONTIER_ENTRIES: readonly FactorizedFrontierEntry[] = Object.freeze([]);
const EMPTY_PENDING_AGGREGATES: PendingFrontierAggregates = Object.freeze({
    any: Object.freeze([]),
    ranks: Object.freeze([]),
    count: Object.freeze([]),
    shownClueDistribution: new Map()
});

function aggregateProjectedResults(
    results: ReadonlyMap<PackedCombo, bigint>,
    indexToEnchant: readonly number[]
): ComboMassAggregates {
    const aggregates = createMutableComboMassAggregates();
    for (const [combo, mass] of results) {
        addComboAggregate(aggregates, combo, ComboUtils.getCount(combo), mass, indexToEnchant);
    }

    return Object.freeze({
        any: Object.freeze(aggregates.any.slice()),
        ranks: Object.freeze(aggregates.ranks.slice()),
        count: Object.freeze(aggregates.count.slice()),
        shownClueDistribution: new Map(aggregates.shownClueDistribution)
    });
}

function createMutableComboMassAggregates(): MutableComboMassAggregates {
    return {
        any: [],
        ranks: [],
        count: [],
        shownClueDistribution: new Map()
    };
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
