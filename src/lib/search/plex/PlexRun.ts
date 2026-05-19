import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { ProbabilityMassAccountant } from '#engine/search/ProbabilityMassAccountant.js';
import type { PackedCombo } from '#types/index.js';
import type { MassAccountingBreakdown } from '#types/mass.js';
import { ComboUtils, PRECISION, ProbUtils } from '#utils/index.js';
import type { SearchPool, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { PlexGraph, type PlexNodeId } from '#lib/search/plex/PlexGraph.js';
import { PlexRunFrontier, type PlexFrontierPopTarget } from '#lib/search/plex/PlexRunFrontier.js';
import {
    appendPlexPayloadEdge,
    EMPTY_PLEX_PAYLOAD,
    getPlexPayloadKey,
    materializeBookFactors,
    materializePlexPayloadFactors,
    type PlexPayload,
    type PlexPayloadKey
} from '#lib/search/plex/PlexPayload.js';

export interface PlexRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
    readonly targetClueId?: number | undefined;
}

export interface PlexRunAdvanceRequest {
    readonly maxIterations: number;
}

export interface PlexPendingEntry {
    readonly graphId: number;
    readonly nodeId: PlexNodeId;
    readonly mass: bigint;
    readonly payload: PlexPayload;
    readonly count: number;
    readonly currentLevel: number;
}

/** Recorded probability mass for a stopped plex payload expression. */
export interface PlexResult {
    readonly payload: PlexPayload;
    readonly mass: bigint;
}

export interface ProjectedPlexResults {
    readonly results: ReadonlyMap<PackedCombo, bigint>;
    /**
     * Resolved plex mass that could not be assigned to concrete combo rows during projection.
     *
     * This is not a search-resolution bucket: the plex result was resolved. It is an
     * accuracy loss in the concrete compatibility view caused by integer division
     * while expanding factorized choices.
     */
    readonly projectionLoss: bigint;
    /** Concrete-view projected mass after subtracting projection loss from resolved plex mass. */
    readonly projectedMass: bigint;
    /** Mass accounting for consumers that summarize the projected concrete result view. */
    readonly mass: MassAccountingBreakdown;
}

export interface PlexRunSnapshot {
    readonly results: ReadonlyMap<PlexPayloadKey, PlexResult>;
    readonly mass: MassAccountingBreakdown;
    readonly iterations: number;
    readonly lastExpandedMass: bigint;
    readonly pendingCount: number;
    readonly largestPendingMass: bigint;
    readonly pendingEntries: readonly PlexPendingEntry[];
    readonly graphCount: number;
    readonly seededLevelCount: number;
    readonly fullyResolved: boolean;
}

interface PlexGraphRecord {
    readonly id: number;
    readonly graph: PlexGraph;
}

type PendingPlexWork = PlexFrontierPopTarget;

export function projectPlexResults(
    results: ReadonlyMap<PlexPayloadKey, PlexResult>,
    enchantToIndex: Map<number, number>,
    sourceMass?: MassAccountingBreakdown,
    options: {
        readonly applyBookRemoval?: boolean | undefined;
        readonly targetClueId?: number | undefined;
        readonly indexToEnchant?: readonly number[] | undefined;
    } = {}
): ProjectedPlexResults {
    const projected = new Map<PackedCombo, bigint>();
    let projectedMass = 0n;
    let projectionLoss = 0n;
    let clueIncompatible = 0n;
    let resolvedMass = 0n;

    for (const result of results.values()) {
        resolvedMass += result.mass;
        let assigned = 0n;
        const factors = options.applyBookRemoval
            ? materializeBookFactors(result.payload, enchantToIndex)
            : materializePlexPayloadFactors(result.payload, enchantToIndex);
        for (const factor of factors) {
            const mass = (result.mass * factor.numerator) / factor.denominator;
            assigned += mass;
            if (options.targetClueId !== undefined && !containsTargetClue(factor.combo, options.targetClueId, options.indexToEnchant)) {
                clueIncompatible += mass;
                continue;
            }
            projectedMass += mass;
            projected.set(factor.combo, (projected.get(factor.combo) ?? 0n) + mass);
        }
        // Projection loss reduces concrete-view accuracy, not internal resolved mass.
        projectionLoss += result.mass - assigned;
    }

    return Object.freeze({
        results: new Map(projected),
        projectionLoss,
        projectedMass,
        mass: createProjectedMassAccounting(sourceMass ?? createProjectionMass(resolvedMass), projectedMass, projectionLoss, clueIncompatible)
    });
}

function containsTargetClue(
    combo: PackedCombo,
    targetClueId: number,
    indexToEnchant: readonly number[] | undefined
): boolean {
    if (!indexToEnchant) throw new Error('Plex clue projection requires indexToEnchant.');
    let found = false;
    ComboUtils.forEachEnchant(combo, indexToEnchant as number[], enchant => {
        if (enchant === targetClueId) found = true;
    });
    return found;
}

function createProjectedMassAccounting(
    sourceMass: MassAccountingBreakdown,
    projectedMass: bigint,
    projectionLoss: bigint,
    projectedClueIncompatible: bigint
): MassAccountingBreakdown {
    const sourceUnits = getMassUnits(sourceMass);
    const clueIncompatible = sourceUnits.clueIncompatible + projectedClueIncompatible;
    return Object.freeze({
        resolved: 0,
        clueIncompatible: ProbUtils.toNumber(clueIncompatible),
        projected: ProbUtils.toNumber(projectedMass),
        pending: sourceMass.pending,
        sieved: sourceMass.sieved,
        overflow: sourceMass.overflow,
        capped: sourceMass.capped,
        rounding: sourceMass.rounding,
        projectionLoss: ProbUtils.toNumber(projectionLoss),
        recoveredRounding: sourceMass.recoveredRounding,
        recoveredSieved: sourceMass.recoveredSieved,
        units: Object.freeze({
            resolved: '0',
            clueIncompatible: clueIncompatible.toString(),
            projected: projectedMass.toString(),
            pending: sourceUnits.pending.toString(),
            sieved: sourceUnits.sieved.toString(),
            overflow: sourceUnits.overflow.toString(),
            capped: sourceUnits.capped.toString(),
            rounding: sourceUnits.rounding.toString(),
            projectionLoss: projectionLoss.toString(),
            recoveredRounding: sourceUnits.recoveredRounding.toString(),
            recoveredSieved: sourceUnits.recoveredSieved.toString()
        })
    });
}

function createProjectionMass(resolvedMass: bigint): MassAccountingBreakdown {
    return Object.freeze({
        resolved: ProbUtils.toNumber(resolvedMass),
        clueIncompatible: 0,
        pending: 0,
        sieved: 0,
        overflow: 0,
        capped: 0,
        rounding: 0,
        recoveredRounding: 0,
        recoveredSieved: 0,
        units: Object.freeze({
            resolved: resolvedMass.toString(),
            clueIncompatible: '0',
            pending: '0',
            sieved: '0',
            overflow: '0',
            capped: '0',
            rounding: '0',
            recoveredRounding: '0',
            recoveredSieved: '0'
        })
    });
}

function getMassUnits(mass: MassAccountingBreakdown): {
    resolved: bigint;
    clueIncompatible: bigint;
    pending: bigint;
    sieved: bigint;
    overflow: bigint;
    capped: bigint;
    rounding: bigint;
    recoveredRounding: bigint;
    recoveredSieved: bigint;
} {
    const units = mass.units;
    return {
        resolved: BigInt(units?.resolved ?? 0),
        clueIncompatible: BigInt(units?.clueIncompatible ?? 0),
        pending: BigInt(units?.pending ?? 0),
        sieved: BigInt(units?.sieved ?? 0),
        overflow: BigInt(units?.overflow ?? 0),
        capped: BigInt(units?.capped ?? 0),
        rounding: BigInt(units?.rounding ?? 0),
        recoveredRounding: BigInt(units?.recoveredRounding ?? 0),
        recoveredSieved: BigInt(units?.recoveredSieved ?? 0)
    };
}

/**
 * Minimal opt-in executor shell for plex search experiments.
 *
 * This intentionally does not replace `SearchRun`. The first slice only seeds
 * modified-level mass into plex structural graphs with explicit payloads so the
 * frontier/result shape can be tested before concrete materialization and full
 * residue parity are introduced.
 */
export class PlexRun {
    public readonly results = new Map<PlexPayloadKey, PlexResult>();
    public readonly mass = new ProbabilityMassAccountant();

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly graphsBySignature = new Map<SearchPoolSignature, PlexGraphRecord>();
    private readonly graphs: PlexGraphRecord[] = [];
    private readonly frontier = new PlexRunFrontier();
    private seeded = false;
    private _seededLevelCount = 0;
    private _iterations = 0;
    private _lastExpandedMass = 0n;
    private readonly targetClueId: number | undefined;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: PlexRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
        this.targetClueId = options.targetClueId;
    }

    public seedXp(xp: number): void {
        if (this.seeded) throw new Error('PlexRun can only be seeded once. Create a new run for a new cell.');
        this.seeded = true;

        const distribution = this.distributionService.getModifiedLevelDist(
            this.kernel.registry,
            xp,
            this.kernel.enchantability
        );

        let seededMass = 0n;
        for (const [levelText, rootMass] of Object.entries(distribution)) {
            if (rootMass === 0n) continue;
            const level = Number(levelText);
            const pool = this.kernel.getPool(level);
            const graph = this.graphForPool(pool);
            const root = graph.graph.getRootNode(level);

            this.pushPending(graph.id, root.id, rootMass, EMPTY_PLEX_PAYLOAD);
            seededMass += rootMass;
            this._seededLevelCount++;
        }

        if (seededMass < PRECISION) this.mass.record('rounding', PRECISION - seededMass);
        if (seededMass > PRECISION) throw new Error(`Modified-level distribution overflowed precision by ${seededMass - PRECISION} units.`);
    }

    public step(): boolean {
        if (!this.seeded) throw new Error('PlexRun must be seeded before stepping.');
        const current = this.popLargestPending();
        if (!current) return false;

        this.mass.subtract('pending', current.mass);
        this._lastExpandedMass = current.mass;
        this.expand(current);
        this._iterations++;
        return true;
    }

    public advance(request: PlexRunAdvanceRequest): PlexRunSnapshot {
        this.validateMaxIterations(request.maxIterations);
        if (!this.seeded) throw new Error('PlexRun must be seeded before advancing.');

        for (let i = 0; i < request.maxIterations; i++) {
            if (!this.step()) break;
        }

        return this.snapshot();
    }

    public projectResults(): ProjectedPlexResults {
        return projectPlexResults(this.results, this.kernel.registry.enchantToIndex, this.mass.toPublic(), {
            applyBookRemoval: this.kernel.item === 'book',
            targetClueId: this.targetClueId,
            indexToEnchant: this.kernel.registry.indexToEnchant
        });
    }

    public snapshot(): PlexRunSnapshot {
        return Object.freeze({
            results: new Map(this.results),
            mass: this.mass.toPublic(),
            iterations: this._iterations,
            lastExpandedMass: this._lastExpandedMass,
            pendingCount: this.frontier.size,
            largestPendingMass: this.frontier.peekMass(),
            pendingEntries: Object.freeze(this.getPendingEntries()),
            graphCount: this.graphs.length,
            seededLevelCount: this._seededLevelCount,
            fullyResolved: this.frontier.size === 0
        });
    }

    public getGraph(graphId: number): PlexGraph {
        return this.getGraphById(graphId).graph;
    }

    private validateMaxIterations(maxIterations: number): void {
        if (!Number.isFinite(maxIterations) || !Number.isInteger(maxIterations) || maxIterations <= 0) {
            throw new Error(`Invalid maxIterations: ${maxIterations}. Must be a positive integer.`);
        }
    }

    private expand(current: PendingPlexWork): void {
        const graph = this.getGraphById(current.graphId).graph;
        const expansion = graph.getExpansion(current.nodeId);

        if (expansion.isRoot) {
            this.forwardOrResolve(current, current.mass);
            return;
        }

        const probStop = ProbUtils.scale(current.mass, PRECISION - expansion.probContinue);
        const probForward = current.mass - probStop;
        this.recordResolved(current.payload, probStop);

        if (probForward === 0n) return;
        if (expansion.terminalReason === 'max-enchants') {
            this.mass.record('overflow', probForward);
            return;
        }

        this.forwardOrResolve(current, probForward);
    }

    private forwardOrResolve(current: PendingPlexWork, mass: bigint): void {
        if (mass === 0n) return;
        const graph = this.getGraphById(current.graphId).graph;
        const expansion = graph.getExpansion(current.nodeId);
        if (expansion.totalWeight <= 0 || expansion.edges.length === 0) {
            this.recordResolved(current.payload, mass);
            return;
        }

        let assigned = 0n;
        const totalWeight = BigInt(expansion.totalWeight);
        for (const edge of expansion.edges) {
            if (edge.weight <= 0) continue;
            const childMass = (mass * BigInt(edge.weight)) / totalWeight;
            assigned += childMass;
            this.pushPending(
                current.graphId,
                edge.childId,
                childMass,
                appendPlexPayloadEdge(current.payload, edge)
            );
        }

        const roundingLoss = mass - assigned;
        if (roundingLoss > 0n) this.mass.record('rounding', roundingLoss);
    }

    private recordResolved(payload: PlexPayload, mass: bigint): void {
        if (mass === 0n) return;
        const key = getPlexPayloadKey(payload);
        const existing = this.results.get(key);
        this.results.set(key, Object.freeze({
            payload: existing?.payload ?? payload,
            mass: (existing?.mass ?? 0n) + mass
        }));
        this.mass.record('resolved', mass);
    }

    private pushPending(graphId: number, nodeId: PlexNodeId, mass: bigint, payload: PlexPayload): void {
        if (mass === 0n) return;
        this.frontier.pushOrMerge(graphId, nodeId, mass, payload);
        this.mass.record('pending', mass);
    }

    private popLargestPending(): PendingPlexWork | undefined {
        const current: PendingPlexWork = {
            graphId: 0,
            nodeId: 0 as PlexNodeId,
            mass: 0n,
            payload: EMPTY_PLEX_PAYLOAD
        };
        return this.frontier.pop(current) ? current : undefined;
    }

    private getPendingEntries(): PlexPendingEntry[] {
        const entries: PlexPendingEntry[] = [];
        this.frontier.forEach(entry => {
            const node = this.getGraphById(entry.graphId).graph.getNode(entry.nodeId);
            entries.push(Object.freeze({
                graphId: entry.graphId,
                nodeId: entry.nodeId,
                mass: entry.mass,
                payload: entry.payload,
                count: node.count,
                currentLevel: node.currentLevel
            }));
        });
        return entries;
    }

    private graphForPool(pool: SearchPool): PlexGraphRecord {
        const existing = this.graphsBySignature.get(pool.signature);
        if (existing) return existing;

        const record = Object.freeze({
            id: this.graphs.length,
            graph: new PlexGraph(this.kernel, pool, { clueMode: this.targetClueId === undefined ? null : `target:${this.targetClueId}` })
        });
        this.graphs.push(record);
        this.graphsBySignature.set(pool.signature, record);
        return record;
    }

    private getGraphById(graphId: number): PlexGraphRecord {
        const record = this.graphs[graphId];
        if (!record) throw new Error(`Unknown plex graph ID ${graphId}`);
        return record;
    }
}
