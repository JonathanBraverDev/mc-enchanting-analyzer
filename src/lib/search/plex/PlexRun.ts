import { ENGINE_LIMITS, PACKING_CONSTANTS } from '#constants/engine.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { ProbabilityMassAccountant } from '#engine/search/ProbabilityMassAccountant.js';
import type { EngineExitReason } from '#types/engine.js';
import type { PackedCombo, PackedEnchant } from '#types/index.js';
import type { MassAccountingBreakdown, MassAccountingPhases, ProjectionAccountingBreakdown } from '#types/mass.js';
import { AsyncUtils, ComboUtils, PRECISION, ProbUtils } from '#utils/index.js';
import type { PendingFrontierEntry } from '#lib/search/SearchRun.js';
import type { SearchGraphNodeId } from '#lib/search/SearchGraph.js';
import type { SearchPool, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { PlexGraph, type PlexNodeId } from '#lib/search/plex/PlexGraph.js';
import { PlexWorkStore, type PlexWorkItem } from '#lib/search/plex/PlexWorkStore.js';
import { PlexPayloadStore } from '#lib/search/plex/PlexPayloadStore.js';
import {
    type PlexPayload,
    type PlexPayloadKey
} from '#lib/search/plex/PlexPayload.js';
import type { PlexFrontierIdentityMode } from '#lib/search/plex/PlexRunFrontier.js';

export interface PlexRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
    readonly targetClueId?: number | undefined;
    readonly frontierIdentityMode?: PlexFrontierIdentityMode | undefined;
}

export interface PlexRunAdvanceRequest {
    readonly maxIterations: number;
}

export interface PlexRunCheckpointRequest {
    readonly threshold?: number | bigint | undefined;
    readonly maxIterations?: number | undefined;
    readonly exhaustive?: boolean | undefined;
    readonly targetClassifiedMass?: number | bigint | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly yieldEveryIterations?: number | undefined;
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
    /** Phase-scoped mass accounting with separate invariants per stage. */
    readonly mass: MassAccountingPhases;
}

export interface ProjectedPlexCheckpoint {
    readonly results: ReadonlyMap<PackedCombo, bigint>;
    readonly pendingEntries: readonly PendingFrontierEntry[];
    readonly projectionLoss: bigint;
    readonly projectedMass: bigint;
    readonly projectedResultMass: bigint;
    readonly projectedPendingMass: bigint;
    readonly mass: MassAccountingPhases;
    readonly iterations: number;
    readonly lastExpandedMass: bigint;
    readonly pendingCount: number;
    readonly largestPendingMass: bigint;
    readonly graphCount: number;
    readonly seededLevelCount: number;
    readonly activeResidueCount: number;
    readonly activeResidueMass: bigint;
    readonly fullyResolved: boolean;
    readonly exitReason?: EngineExitReason | undefined;
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
    readonly activeResidueCount: number;
    readonly activeResidueMass: bigint;
    readonly fullyResolved: boolean;
    readonly exitReason?: EngineExitReason | undefined;
}

interface PlexGraphRecord {
    readonly id: number;
    readonly graph: PlexGraph;
}

type PendingPlexWork = PlexWorkItem;

interface PlexAdvanceCriteria {
    readonly threshold: bigint;
    readonly maxIterations: number;
    readonly targetClassifiedMass?: bigint | undefined;
    readonly signal?: AbortSignal | undefined;
}

interface PlexProjectionOptions {
    readonly applyBookRemoval?: boolean | undefined;
    readonly targetClueId?: number | undefined;
    readonly indexToEnchant?: readonly number[] | undefined;
}

interface PlexProjectionAccumulator {
    readonly results: Map<PackedCombo, bigint>;
    readonly pendingEntries: PendingFrontierEntry[];
    projectedResultMass: bigint;
    projectedPendingMass: bigint;
    clueIncompatible: bigint;
    loss: bigint;
    source: bigint;
}

export function projectPlexResults(
    results: ReadonlyMap<PlexPayloadKey, PlexResult>,
    enchantToIndex: Map<number, number>,
    sourceMass?: MassAccountingBreakdown,
    options: PlexProjectionOptions = {}
): ProjectedPlexResults {
    const acc = createProjectionAccumulator();

    for (const result of results.values()) {
        projectPlexPayloadMass(acc, result.payload, result.mass, enchantToIndex, options, 'result');
    }

    const projectedMass = acc.projectedResultMass;

    return Object.freeze({
        results: new Map(acc.results),
        projectionLoss: acc.loss,
        projectedMass,
        mass: Object.freeze({
            engine: sourceMass ?? createProjectionSourceMass(acc.source),
            projection: createProjectionAccounting(acc.source, projectedMass, acc.clueIncompatible, acc.loss)
        })
    });
}

export function projectPlexCheckpoint(
    snapshot: PlexRunSnapshot,
    enchantToIndex: Map<number, number>,
    options: PlexProjectionOptions = {}
): ProjectedPlexCheckpoint {
    const acc = createProjectionAccumulator();

    for (const result of snapshot.results.values()) {
        projectPlexPayloadMass(acc, result.payload, result.mass, enchantToIndex, options, 'result');
    }

    for (const entry of snapshot.pendingEntries) {
        // Pending entries are still live frontier state, not final book rows. Keep
        // them pre-book-removal so downstream aggregate projections can apply the
        // same pending-book approximation they use for concrete SearchRun entries.
        projectPlexPayloadMass(acc, entry.payload, entry.mass, enchantToIndex, {
            ...options,
            applyBookRemoval: false
        }, 'pending', entry);
    }

    const projectedMass = acc.projectedResultMass + acc.projectedPendingMass;

    return Object.freeze({
        results: new Map(acc.results),
        pendingEntries: Object.freeze(acc.pendingEntries),
        projectionLoss: acc.loss,
        projectedMass,
        projectedResultMass: acc.projectedResultMass,
        projectedPendingMass: acc.projectedPendingMass,
        mass: Object.freeze({
            engine: snapshot.mass,
            projection: createProjectionAccounting(acc.source, projectedMass, acc.clueIncompatible, acc.loss)
        }),
        iterations: snapshot.iterations,
        lastExpandedMass: snapshot.lastExpandedMass,
        pendingCount: snapshot.pendingCount,
        largestPendingMass: snapshot.largestPendingMass,
        graphCount: snapshot.graphCount,
        seededLevelCount: snapshot.seededLevelCount,
        activeResidueCount: snapshot.activeResidueCount,
        activeResidueMass: snapshot.activeResidueMass,
        fullyResolved: snapshot.fullyResolved,
        exitReason: snapshot.exitReason
    });
}

function createProjectionAccumulator(): PlexProjectionAccumulator {
    return {
        results: new Map<PackedCombo, bigint>(),
        pendingEntries: [],
        projectedResultMass: 0n,
        projectedPendingMass: 0n,
        clueIncompatible: 0n,
        loss: 0n,
        source: 0n
    };
}

function projectPlexPayloadMass(
    acc: PlexProjectionAccumulator,
    payload: PlexPayload,
    sourceMass: bigint,
    enchantToIndex: Map<number, number>,
    options: PlexProjectionOptions,
    target: 'result' | 'pending',
    pendingSource?: PlexPendingEntry | undefined
): void {
    acc.source += sourceMass;
    const clueSurvival = calculateClueSurvival(payload, options.targetClueId);
    const clueEligibleMass = (sourceMass * clueSurvival.numerator) / clueSurvival.denominator;
    acc.clueIncompatible += sourceMass - clueEligibleMass;
    if (clueEligibleMass === 0n) return;

    let assigned = 0n;
    const visitFactor = (combo: PackedCombo, numerator: bigint, denominator: bigint): void => {
        const mass = (sourceMass * numerator * clueSurvival.numerator) /
            (denominator * clueSurvival.denominator);
        assigned += mass;
        if (mass === 0n) return;
        if (target === 'result') {
            acc.projectedResultMass += mass;
            if (combo !== 0) acc.results.set(combo, (acc.results.get(combo) ?? 0n) + mass);
        } else if (pendingSource) {
            acc.projectedPendingMass += mass;
            acc.pendingEntries.push(Object.freeze({
                graphId: pendingSource.graphId,
                nodeId: pendingSource.nodeId as unknown as SearchGraphNodeId,
                mass,
                combo,
                count: ComboUtils.getCount(combo)
            }));
        }
    };
    if (options.applyBookRemoval) {
        defaultPayloadStore.forEachBookFactor(payload, enchantToIndex, visitFactor);
    } else {
        defaultPayloadStore.forEachFactor(payload, enchantToIndex, visitFactor);
    }
    // Projection loss reduces concrete-view accuracy, not internal engine mass.
    acc.loss += clueEligibleMass - assigned;
}

function calculateClueSurvival(
    payload: PlexPayload,
    targetClueId: number | undefined
): { numerator: bigint; denominator: bigint } {
    if (targetClueId === undefined) return { numerator: 1n, denominator: 1n };
    if (payload.combo.fixed.some(packedEnchant => matchesClueTarget(packedEnchant, targetClueId))) {
        return { numerator: 1n, denominator: 1n };
    }

    for (const choice of payload.choices) {
        let matchingWeight = 0;
        for (const alternative of choice.alternatives) {
            if (matchesClueTarget(alternative.packedEnchant, targetClueId)) {
                matchingWeight += alternative.weight;
            }
        }
        if (matchingWeight > 0) {
            return {
                numerator: BigInt(matchingWeight),
                denominator: BigInt(choice.totalWeight)
            };
        }
    }

    return { numerator: 0n, denominator: 1n };
}

function matchesClueTarget(packedEnchant: PackedEnchant, targetClueId: number): boolean {
    const targetEnchantId = targetClueId >> PACKING_CONSTANTS.ENCHANT_SHIFT;
    const targetRank = targetClueId & PACKING_CONSTANTS.RANK_MASK;
    const enchantId = packedEnchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
    const rank = packedEnchant & PACKING_CONSTANTS.RANK_MASK;
    return enchantId === targetEnchantId && rank >= targetRank;
}

function createProjectionAccounting(
    source: bigint,
    projected: bigint,
    clueIncompatible: bigint,
    loss: bigint
): ProjectionAccountingBreakdown {
    return Object.freeze({
        source: ProbUtils.toNumber(source),
        projected: ProbUtils.toNumber(projected),
        clueIncompatible: ProbUtils.toNumber(clueIncompatible),
        loss: ProbUtils.toNumber(loss),
        units: Object.freeze({
            source: source.toString(),
            projected: projected.toString(),
            clueIncompatible: clueIncompatible.toString(),
            loss: loss.toString()
        })
    });
}

function createProjectionSourceMass(resolvedMass: bigint): MassAccountingBreakdown {
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

/**
 * Minimal opt-in executor shell for plex search experiments.
 *
 * This intentionally does not replace `SearchRun`. The first slice only seeds
 * modified-level mass into plex structural graphs with explicit payloads so the
 * frontier/result shape can be tested before concrete materialization and full
 * residue parity are introduced.
 */
const defaultPayloadStore = new PlexPayloadStore();

export class PlexRun {
    public readonly results = new Map<PlexPayloadKey, PlexResult>();
    public readonly mass = new ProbabilityMassAccountant();

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly graphsBySignature = new Map<SearchPoolSignature, PlexGraphRecord>();
    private readonly graphs: PlexGraphRecord[] = [];
    private readonly payloads = new PlexPayloadStore();
    private readonly work: PlexWorkStore;
    private seeded = false;
    private _seededLevelCount = 0;
    private _iterations = 0;
    private _lastExpandedMass = 0n;
    private _exitReason: EngineExitReason | undefined;
    private readonly targetClueId: number | undefined;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: PlexRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
        this.targetClueId = options.targetClueId;
        this.work = new PlexWorkStore(this.payloads, {
            frontierIdentityMode: options.frontierIdentityMode
        });
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
            if (this.targetClueId !== undefined && !pool.entries.some(entry => matchesClueTarget(entry.packedEnchant, this.targetClueId!))) {
                this.mass.record('clueIncompatible', rootMass);
                seededMass += rootMass;
                this._seededLevelCount++;
                continue;
            }

            const graph = this.graphForPool(pool);
            const root = graph.graph.getRootNode(level);

            this.pushPending(graph.id, root.id, rootMass, this.payloads.empty);
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

        this._exitReason = undefined;
        this.mass.subtract('pending', current.mass);
        this._lastExpandedMass = current.mass;
        this.expand(current);
        this._iterations++;
        return true;
    }

    public advance(request: PlexRunAdvanceRequest): PlexRunSnapshot {
        if (!this.seeded) throw new Error('PlexRun must be seeded before advancing.');
        return this.searchToCheckpoint({ maxIterations: this._iterations + request.maxIterations });
    }

    public searchToCheckpoint(request: PlexRunCheckpointRequest = {}): PlexRunSnapshot {
        const criteria = this.createAdvanceCriteria(request);
        this.advanceUntilCheckpoint(criteria);
        return this.snapshot();
    }

    public async searchToCheckpointAsync(request: PlexRunCheckpointRequest = {}): Promise<PlexRunSnapshot> {
        const criteria = this.createAdvanceCriteria(request);
        const chunkIterations = Math.max(
            1,
            request.yieldEveryIterations ?? ENGINE_LIMITS.ASYNC_SEARCH_CHUNK_ITERATIONS
        );

        while (!this.advanceUntilCheckpoint(criteria, chunkIterations)) {
            await AsyncUtils.yield();
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

    public projectCheckpoint(snapshot: PlexRunSnapshot = this.snapshot()): ProjectedPlexCheckpoint {
        return projectPlexCheckpoint(snapshot, this.kernel.registry.enchantToIndex, {
            applyBookRemoval: this.kernel.item === 'book',
            targetClueId: this.targetClueId,
            indexToEnchant: this.kernel.registry.indexToEnchant
        });
    }

    public snapshot(): PlexRunSnapshot {
        const residue = this.getActiveResidueStats();
        return Object.freeze({
            results: new Map(this.results),
            mass: this.mass.toPublic(),
            iterations: this._iterations,
            lastExpandedMass: this._lastExpandedMass,
            pendingCount: this.work.size,
            largestPendingMass: this.work.peekMass(),
            pendingEntries: Object.freeze(this.getPendingEntries()),
            graphCount: this.graphs.length,
            seededLevelCount: this._seededLevelCount,
            activeResidueCount: residue.count,
            activeResidueMass: residue.mass,
            fullyResolved: this.work.size === 0,
            exitReason: this.work.size === 0 ? 'empty' : this._exitReason
        });
    }

    public getGraph(graphId: number): PlexGraph {
        return this.getGraphById(graphId).graph;
    }

    private createAdvanceCriteria(request: PlexRunCheckpointRequest): PlexAdvanceCriteria {
        if (!this.seeded) throw new Error('PlexRun must be seeded before searching.');

        if (request.maxIterations !== undefined) this.validateMaxIterations(request.maxIterations);
        this.validateProbabilityInput(request.threshold, 'threshold', 'Threshold must be between 0 and 1.0.');
        this.validateProbabilityInput(request.targetClassifiedMass, 'targetClassifiedMass', 'Must be between 0 and 1.0.');
        const targetClassifiedMass = request.targetClassifiedMass !== undefined
            ? ProbUtils.toBigInt(request.targetClassifiedMass)
            : undefined;
        const threshold = request.exhaustive ? 0n : ProbUtils.toBigInt(request.threshold ?? 0n);
        const maxIterations = request.exhaustive
            ? Number.POSITIVE_INFINITY
            : request.maxIterations ?? Number.POSITIVE_INFINITY;

        const hasBoundedStopCondition = targetClassifiedMass !== undefined
            || (request.threshold !== undefined && threshold > 0n)
            || request.maxIterations !== undefined;
        if (!request.exhaustive && !hasBoundedStopCondition) {
            throw new Error('PlexRun has no bounded stop condition. Provide a positive threshold, a finite maxIterations, a mass target, or set exhaustive: true.');
        }

        return {
            threshold,
            maxIterations,
            targetClassifiedMass,
            signal: request.signal
        };
    }

    private validateProbabilityInput(value: number | bigint | undefined, label: string, requirement: string): void {
        if (value === undefined) return;
        const normalized = ProbUtils.toNumber(value);
        if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1.0) {
            throw new Error(`Invalid ${label}: ${normalized}. ${requirement}`);
        }
    }

    private advanceUntilCheckpoint(criteria: PlexAdvanceCriteria, chunkIterations?: number): boolean {
        this._exitReason = undefined;
        let advancedInChunk = 0;

        while (true) {
            if (criteria.signal?.aborted) throw new Error('Aborted');
            const exitReason = this.getExitReason(criteria);
            if (exitReason !== undefined) {
                this._exitReason = exitReason;
                return true;
            }
            if (chunkIterations !== undefined && advancedInChunk >= chunkIterations) return false;
            if (!this.step()) {
                this._exitReason = 'empty';
                return true;
            }
            advancedInChunk++;
        }
    }

    private getExitReason(criteria: PlexAdvanceCriteria): EngineExitReason | undefined {
        if (this.work.size === 0) return 'empty';
        if (criteria.targetClassifiedMass !== undefined && this.mass.getClassifiedMass() >= criteria.targetClassifiedMass) return 'mass';
        if (this.work.peekMass() < criteria.threshold) return 'threshold';
        if (this._iterations >= criteria.maxIterations) return 'iterations';
        return undefined;
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

        const totalWeight = BigInt(expansion.totalWeight);
        const oldResidues = this.work.getForwardingResidues(current);
        const oldResidueMass = this.calculateForwardingResidueMass(oldResidues, totalWeight);
        const nextResidues = new BigUint64Array(expansion.edges.length);
        let assigned = 0n;
        let standaloneAssigned = 0n;
        let nextResidueNumerator = 0n;
        let hasResidue = false;

        for (let edgeIndex = 0; edgeIndex < expansion.edges.length; edgeIndex++) {
            const edge = expansion.edges[edgeIndex]!;
            if (edge.weight <= 0) continue;
            const weight = BigInt(edge.weight);
            const numerator = (mass * weight) + (oldResidues?.[edgeIndex] ?? 0n);
            const childMass = numerator / totalWeight;
            const edgeResidue = numerator - (childMass * totalWeight);
            nextResidues[edgeIndex] = edgeResidue;
            nextResidueNumerator += edgeResidue;
            hasResidue ||= edgeResidue !== 0n;
            assigned += childMass;
            standaloneAssigned += (mass * weight) / totalWeight;
            this.pushPending(
                current.graphId,
                edge.childId,
                childMass,
                this.work.appendPayloadEdge(current.payload, edge)
            );
        }

        const newResidueMass = nextResidueNumerator / totalWeight;
        this.work.setForwardingResidues(current, hasResidue ? nextResidues : undefined);
        this.recordResidueDelta(oldResidueMass, newResidueMass);
        this.recordResiduePromotion(assigned - standaloneAssigned);
    }

    private calculateForwardingResidueMass(residues: BigUint64Array | undefined, totalWeight: bigint): bigint {
        if (!residues) return 0n;
        let numerator = 0n;
        for (const residue of residues) numerator += residue;
        return numerator / totalWeight;
    }

    private recordResidueDelta(oldResidue: bigint, newResidue: bigint): void {
        if (newResidue > oldResidue) {
            this.mass.record('rounding', newResidue - oldResidue);
            return;
        }

        if (oldResidue > newResidue) {
            this.mass.subtract('rounding', oldResidue - newResidue);
        }
    }

    private recordResiduePromotion(promotedMass: bigint): void {
        if (promotedMass > 0n) this.mass.record('recoveredRounding', promotedMass);
    }

    private getActiveResidueStats(): { count: number; mass: bigint } {
        return this.work.getActiveResidueStats((graphId, nodeId) => {
            const graph = this.getGraphById(graphId).graph;
            return graph.getExpansion(nodeId).totalWeight;
        });
    }

    private recordResolved(payload: PlexPayload, mass: bigint): void {
        if (mass === 0n) return;
        const key = this.payloads.key(payload);
        const existing = this.results.get(key);
        this.results.set(key, Object.freeze({
            payload: existing?.payload ?? payload,
            mass: (existing?.mass ?? 0n) + mass
        }));
        this.mass.record('resolved', mass);
    }

    private pushPending(graphId: number, nodeId: PlexNodeId, mass: bigint, payload: PlexPayload): void {
        if (mass === 0n) return;
        this.work.push(graphId, nodeId, mass, payload);
        this.mass.record('pending', mass);
    }

    private popLargestPending(): PendingPlexWork | undefined {
        const current: PendingPlexWork = {
            graphId: 0,
            nodeId: 0 as PlexNodeId,
            mass: 0n,
            payload: this.payloads.empty
        };
        return this.work.popLargest(current) ? current : undefined;
    }

    private getPendingEntries(): PlexPendingEntry[] {
        const entries: PlexPendingEntry[] = [];
        this.work.forEachPending(entry => {
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
