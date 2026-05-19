import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { ProbabilityMassAccountant } from '#engine/search/ProbabilityMassAccountant.js';
import { ClueSearchPolicy } from '#engine/search/ClueSearchPolicy.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { MassAccountingBreakdown } from '#types/mass.js';
import { PackedCombo } from '#types/index.js';
import { AsyncUtils, ComboUtils, PRECISION, ProbUtils } from '#utils/index.js';
import { RegistryKernel, SearchPool, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import { SearchGraph, SearchGraphDiagnostics, SearchGraphExpansion, SearchGraphNodeId } from '#lib/search/SearchGraph.js';
import { SearchExpansionBlueprintCache } from '#lib/search/SearchExpansionBlueprintCache.js';

/** Minimal cache surface a SearchRun needs for structural graph reuse. */
export interface SearchGraphCache {
    getOrCreateGraph(kernel: RegistryKernel, pool: SearchPool, clueMode?: string | null): SearchGraph;
}

/** Construction options for one resumable XP-cell search run. */
export interface SearchRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
    readonly targetClueId?: number | undefined;
    readonly graphCache?: SearchGraphCache | undefined;
    readonly useExpansionBlueprints?: boolean | undefined;
    readonly useSuffixMerging?: boolean | undefined;
}

/**
 * Stop conditions for advancing a SearchRun to the next checkpoint boundary.
 * At least one of `threshold`, `maxIterations`, or a mass target is required unless
 * `exhaustive: true` is set. Two or more stop conditions are recommended for
 * user-facing flows; single-condition requests are useful for controlled diagnostics.
 */
export interface SearchRunCheckpointRequest {
    /** Stop when the largest pending node mass falls below this probability. Use 0/omit to disable this stop. */
    readonly threshold?: number | bigint | undefined;
    /**
     * Maximum graph-node expansions to perform before stopping. Work cap only; pair with a
     * quality/mass stop when possible. Lower caps usually return sooner all else equal, and
     * iterations are the most direct work-budget metric, but no search control is a linear
     * runtime proxy.
     */
    readonly maxIterations?: number | undefined;
    /** Ignore threshold, iteration cap, and classified-mass target, searching until the frontier is empty. */
    readonly exhaustive?: boolean | undefined;
    /** Stop once non-pending mass reaches this absolute fixed-point/number target. Omitted means no classified-mass stop. */
    readonly targetClassifiedMass?: number | bigint | undefined;
    /** Stop once resolved result mass reaches this absolute fixed-point/number target. Internal/specialized use only. */
    readonly targetResolvedMass?: number | bigint | undefined;
    /** Optional internal forward-mass floor. Defaults to 0 so validation can dig into the full tail. */
    readonly probabilityFloor?: number | bigint | undefined;
    readonly signal?: AbortSignal | undefined;
    /** Async search yield cadence. Used by the worker-facing search execution service so abort messages can be observed. */
    readonly yieldEveryIterations?: number | undefined;
}

/** Pending graph-node mass exported for presentation projections and diagnostics. */
export interface PendingFrontierEntry {
    readonly graphId: number;
    readonly nodeId: SearchGraphNodeId;
    readonly mass: bigint;
    readonly combo: PackedCombo;
    readonly count: number;
}

/** Explicit materialized snapshot of live SearchRun state. Expensive for large frontiers. */
export interface SearchRunSnapshot {
    readonly results: ReadonlyMap<PackedCombo, bigint>;
    readonly mass: MassAccountingBreakdown;
    readonly iterations: number;
    /** Mass of the most recently expanded frontier node. Useful for checkpoint overshoot diagnostics. */
    readonly lastExpandedMass: bigint;
    readonly pendingCount: number;
    readonly largestPendingMass: bigint;
    readonly pendingEntries: readonly PendingFrontierEntry[];
    readonly graphCount: number;
    readonly seededLevelCount: number;
    readonly activeResidueCount: number;
    readonly activeResidueMass: bigint;
    readonly fullyResolved: boolean;
    readonly suffixMerging: SearchSuffixMergeDiagnostics;
}

export interface SearchSuffixMergeDiagnostics {
    readonly enabled: boolean;
    readonly canonicalEntryCount: number;
    readonly hits: number;
    readonly misses: number;
    readonly mergedPendingMass: bigint;
    readonly avoidedPendingEntries: number;
}

export interface SearchRunFutureIdentityGroupDiagnostic {
    readonly identity: string;
    readonly pendingCount: number;
    readonly totalMass: bigint;
    readonly largestMass: bigint;
    readonly graphIds: readonly number[];
}

export interface SearchRunFutureCollapseDiagnostics {
    readonly eligiblePendingCount: number;
    readonly identityGroupCount: number;
    readonly collapsibleGroupCount: number;
    readonly collapsiblePendingCount: number;
    readonly collapsibleMass: bigint;
    readonly largestGroupSize: number;
    readonly groups: readonly SearchRunFutureIdentityGroupDiagnostic[];
}

export interface SearchRunGraphDiagnostics extends SearchGraphDiagnostics {
    readonly graphId: number;
}

interface GraphRecord {
    readonly id: number;
    readonly graph: SearchGraph;
    readonly cluePolicy?: ClueSearchPolicy | undefined;
}

interface FrontierPopTarget {
    graphId: number;
    nodeId: SearchGraphNodeId;
    mass: bigint;
}

interface PendingTarget {
    graphId: number;
    nodeId: SearchGraphNodeId;
}

interface EdgeMassShare {
    readonly childId: SearchGraphNodeId;
    mass: bigint;
}

interface AdvanceCriteria {
    readonly threshold: bigint;
    readonly maxIterations: number;
    readonly targetClassifiedMass?: bigint | undefined;
    readonly targetResolvedMass?: bigint | undefined;
    readonly probabilityFloor: bigint;
    readonly signal?: AbortSignal | undefined;
}

/**
 * Resumable probability-flow executor for one item/material/XP cell.
 *
 * A run seeds the modified-level distribution into shared search graphs, then
 * repeatedly expands the largest weighted pending graph node. It owns probability
 * mass, residue accounting, clue pruning, and resolved result mass; it does not
 * own worker protocol or presentation projection.
 */
export class SearchRun {
    public readonly results = new Map<PackedCombo, bigint>();
    public readonly mass = new ProbabilityMassAccountant();

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly graphCache: SearchGraphCache | undefined;
    private readonly localBlueprintCache = new SearchExpansionBlueprintCache();
    private readonly useExpansionBlueprints: boolean;
    private readonly useSuffixMerging: boolean;
    private readonly graphsBySignature = new Map<SearchPoolSignature, GraphRecord>();
    private readonly graphs: GraphRecord[] = [];
    private readonly forwardingResidues: Array<Map<number, BigUint64Array> | undefined> = [];
    private readonly bookRedistributionResidues = new Map<PackedCombo, bigint>();
    private readonly suffixCanonicalNodes = new Map<string, PendingTarget>();
    private readonly targetClueId: number | undefined;
    private readonly frontier = new SearchRunFrontier();
    private seeded = false;
    private _seededLevelCount = 0;
    private _iterations = 0;
    private _lastExpandedMass = 0n;
    private suffixMergeHits = 0;
    private suffixMergeMisses = 0;
    private suffixMergedPendingMass = 0n;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: SearchRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
        this.graphCache = options.graphCache;
        this.targetClueId = options.targetClueId;
        this.useExpansionBlueprints = options.useExpansionBlueprints ?? true;
        this.useSuffixMerging = options.useSuffixMerging ?? false;
    }

    /** Seeds the run with the modified-level distribution for one table XP value. */
    public seedXp(xp: number): void {
        if (this.seeded) throw new Error('SearchRun can only be seeded once. Create a new run for a new cell.');
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
            if (graph.cluePolicy && !graph.cluePolicy.isReachableInPool) {
                this.mass.record('clueIncompatible', rootMass);
                seededMass += rootMass;
                this._seededLevelCount++;
                continue;
            }

            const root = graph.graph.getRootNode(level);
            this.pushPending(graph.id, root.id, rootMass);
            seededMass += rootMass;
            this._seededLevelCount++;
        }

        if (seededMass < PRECISION) this.mass.record('rounding', PRECISION - seededMass);
        if (seededMass > PRECISION) throw new Error(`Modified-level distribution overflowed precision by ${seededMass - PRECISION} units.`);
    }

    /** Synchronously advances to a checkpoint/final boundary and returns a materialized snapshot. */
    public searchToCheckpoint(request: SearchRunCheckpointRequest = {}): SearchRunSnapshot {
        const criteria = this.createAdvanceCriteria(request);
        this.advanceUntilCheckpoint(criteria);
        return this.snapshot();
    }

    /** Asynchronously advances to a checkpoint while yielding between scheduler chunks. */
    public async searchToCheckpointAsync(request: SearchRunCheckpointRequest = {}): Promise<SearchRunSnapshot> {
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

    private createAdvanceCriteria(request: SearchRunCheckpointRequest): AdvanceCriteria {
        if (!this.seeded) throw new Error('SearchRun must be seeded before searching.');

        if (request.maxIterations !== undefined && (!Number.isFinite(request.maxIterations) || !Number.isInteger(request.maxIterations) || request.maxIterations <= 0)) {
            throw new Error(`Invalid maxIterations: ${request.maxIterations}. Must be a positive integer.`);
        }
        this.validateProbabilityInput(request.threshold, 'threshold', 'Threshold must be between 0 and 1.0.');
        this.validateProbabilityInput(request.targetClassifiedMass, 'targetClassifiedMass', 'Must be between 0 and 1.0.');
        this.validateProbabilityInput(request.targetResolvedMass, 'targetResolvedMass', 'Must be between 0 and 1.0.');
        this.validateProbabilityInput(request.probabilityFloor, 'probabilityFloor', 'Must be between 0 and 1.0.');

        const targetClassifiedMass = request.targetClassifiedMass !== undefined
            ? ProbUtils.toBigInt(request.targetClassifiedMass)
            : undefined;
        const targetResolvedMass = request.targetResolvedMass !== undefined
            ? ProbUtils.toBigInt(request.targetResolvedMass)
            : undefined;
        const threshold = request.exhaustive ? 0n : ProbUtils.toBigInt(request.threshold ?? 0n);
        const maxIterations = request.exhaustive
            ? Number.POSITIVE_INFINITY
            : request.maxIterations ?? Number.POSITIVE_INFINITY;

        const hasBoundedStopCondition = targetClassifiedMass !== undefined
            || targetResolvedMass !== undefined
            || (request.threshold !== undefined && threshold > 0n)
            || request.maxIterations !== undefined;
        if (!request.exhaustive && !hasBoundedStopCondition) {
            throw new Error('SearchRun has no bounded stop condition. Provide a positive threshold, a finite maxIterations, a mass target, or set exhaustive: true.');
        }

        return {
            threshold,
            maxIterations,
            targetClassifiedMass,
            targetResolvedMass,
            probabilityFloor: request.probabilityFloor !== undefined
                ? ProbUtils.toBigInt(request.probabilityFloor)
                : 0n,
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

    /**
     * Advances live search state until a real checkpoint/final boundary is reached.
     * Optional chunk size is a scheduler budget only; exhausting it yields without
     * materializing an expensive snapshot.
     *
     * @returns true when the requested checkpoint is reached; false when only the chunk budget was exhausted.
     */
    private advanceUntilCheckpoint(criteria: AdvanceCriteria, chunkIterations?: number): boolean {
        const current = { graphId: 0, nodeId: 0 as SearchGraphNodeId, mass: 0n };
        let advancedInChunk = 0;

        while (true) {
            if (criteria.signal?.aborted) throw new Error('Aborted');
            if (this.frontier.size === 0) return true;
            if (this._iterations >= criteria.maxIterations) return true;
            if (criteria.targetClassifiedMass !== undefined && this.mass.getClassifiedMass() >= criteria.targetClassifiedMass) return true;
            if (criteria.targetResolvedMass !== undefined && this.mass.getResolvedMass() >= criteria.targetResolvedMass) return true;
            if (this.frontier.peekMass() < criteria.threshold) return true;
            if (chunkIterations !== undefined && advancedInChunk >= chunkIterations) return false;
            if (!this.frontier.pop(current)) return true;

            this.mass.subtract('pending', current.mass);
            this._lastExpandedMass = current.mass;
            this.expand(current.graphId, current.nodeId, current.mass, criteria.probabilityFloor);
            this._iterations++;
            advancedInChunk++;
        }
    }

    /** Materializes the current run state without advancing search. */
    public snapshot(): SearchRunSnapshot {
        const residue = this.getActiveResidueStats();
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
            activeResidueCount: residue.count,
            activeResidueMass: residue.mass,
            fullyResolved: this.frontier.size === 0,
            suffixMerging: this.getSuffixMergeDiagnostics()
        });
    }

    /** Returns structural graph diagnostics for scripts and performance investigations. */
    public getGraphDiagnostics(includeNodes = false): readonly SearchRunGraphDiagnostics[] {
        return Object.freeze(this.graphs.map(record => Object.freeze({
            graphId: record.id,
            ...record.graph.getDiagnostics(includeNodes)
        })));
    }

    public getSuffixMergeDiagnostics(): SearchSuffixMergeDiagnostics {
        return Object.freeze({
            enabled: this.useSuffixMerging,
            canonicalEntryCount: this.suffixCanonicalNodes.size,
            hits: this.suffixMergeHits,
            misses: this.suffixMergeMisses,
            mergedPendingMass: this.suffixMergedPendingMass,
            avoidedPendingEntries: this.suffixMergeHits
        });
    }

    /**
     * Measurement-only view of pending nodes that already share identical future identity.
     *
     * This warms suffix identities on the inspected graphs, so it can mutate
     * graph-local suffix/blueprint diagnostic counters even though search state
     * and result accounting are unchanged.
     */
    public getFutureCollapseDiagnostics(): SearchRunFutureCollapseDiagnostics {
        const byIdentity = new Map<string, {
            pendingCount: number;
            totalMass: bigint;
            largestMass: bigint;
            graphIds: Set<number>;
        }>();

        this.frontier.forEach((graphId, nodeId, mass) => {
            const identity = this.getGraphById(graphId).graph.getSuffixIdentity(nodeId);
            if (!identity) return;

            const key = String(identity);
            let group = byIdentity.get(key);
            if (!group) {
                group = { pendingCount: 0, totalMass: 0n, largestMass: 0n, graphIds: new Set<number>() };
                byIdentity.set(key, group);
            }

            group.pendingCount++;
            group.totalMass += mass;
            if (mass > group.largestMass) group.largestMass = mass;
            group.graphIds.add(graphId);
        });

        const groups = [...byIdentity.entries()]
            .map(([identity, group]) => Object.freeze({
                identity,
                pendingCount: group.pendingCount,
                totalMass: group.totalMass,
                largestMass: group.largestMass,
                graphIds: Object.freeze([...group.graphIds].sort((a, b) => a - b))
            }))
            .sort((a, b) => {
                const byCount = b.pendingCount - a.pendingCount;
                if (byCount !== 0) return byCount;
                if (a.totalMass === b.totalMass) return 0;
                return a.totalMass < b.totalMass ? 1 : -1;
            });
        const collapsibleGroups = groups.filter(group => group.pendingCount > 1);

        return Object.freeze({
            eligiblePendingCount: groups.reduce((sum, group) => sum + group.pendingCount, 0),
            identityGroupCount: groups.length,
            collapsibleGroupCount: collapsibleGroups.length,
            collapsiblePendingCount: collapsibleGroups.reduce((sum, group) => sum + group.pendingCount, 0),
            collapsibleMass: collapsibleGroups.reduce((sum, group) => sum + group.totalMass, 0n),
            largestGroupSize: groups.reduce((largest, group) => Math.max(largest, group.pendingCount), 0),
            groups: Object.freeze(groups)
        });
    }

    private expand(graphId: number, nodeId: SearchGraphNodeId, incomingMass: bigint, probabilityFloor: bigint): void {
        const record = this.getGraphById(graphId);
        const { graph, cluePolicy } = record;
        const expansion = graph.getExpansion(nodeId);

        if (expansion.isRoot) {
            this.expandRoot(graphId, nodeId, expansion, incomingMass, cluePolicy);
            return;
        }

        this.expandSearchNode(
            graphId,
            nodeId,
            graph.getNodeCombo(nodeId),
            graph.getNodeCount(nodeId),
            expansion,
            incomingMass,
            probabilityFloor,
            cluePolicy
        );
    }

    private expandRoot(
        graphId: number,
        nodeId: SearchGraphNodeId,
        expansion: SearchGraphExpansion,
        incomingMass: bigint,
        cluePolicy: ClueSearchPolicy | undefined
    ): void {
        if (expansion.totalWeight <= 0 || expansion.edges.length === 0) {
            this.mass.record('resolved', incomingMass);
            return;
        }

        this.forwardMass(graphId, nodeId, expansion, incomingMass, 0 as PackedCombo, cluePolicy);
    }

    private expandSearchNode(
        graphId: number,
        nodeId: SearchGraphNodeId,
        combo: PackedCombo,
        count: number,
        expansion: SearchGraphExpansion,
        incomingMass: bigint,
        probabilityFloor: bigint,
        cluePolicy: ClueSearchPolicy | undefined
    ): void {
        const probStop = ProbUtils.scale(incomingMass, PRECISION - expansion.probContinue);
        const probForward = incomingMass - probStop;

        this.recordResolved(combo, count, probStop, cluePolicy);

        if (probForward === 0n) return;

        if (expansion.terminalReason === 'max-enchants') {
            this.mass.record('overflow', probForward);
            return;
        }

        if (expansion.totalWeight <= 0 || expansion.edges.length === 0) {
            this.recordResolved(combo, count, probForward, cluePolicy);
            return;
        }

        if (probabilityFloor > 0n && probForward < probabilityFloor) {
            this.mass.record('sieved', probForward);
            return;
        }

        this.forwardMass(graphId, nodeId, expansion, probForward, combo, cluePolicy);
    }

    private forwardMass(
        graphId: number,
        nodeId: SearchGraphNodeId,
        expansion: SearchGraphExpansion,
        mass: bigint,
        combo: PackedCombo,
        cluePolicy: ClueSearchPolicy | undefined
    ): void {
        const totalWeight = BigInt(expansion.totalWeight);
        const oldResidues = this.getForwardingResidues(graphId, nodeId);
        const oldResidueMass = this.calculateForwardingResidueMass(oldResidues, totalWeight);
        const nextResidues = new BigUint64Array(expansion.edges.length);
        const shares: EdgeMassShare[] = [];
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
            if (cluePolicy && !cluePolicy.canSelectChild(edge.entry.packedEnchant, this.containsTargetClue(combo, cluePolicy))) {
                this.mass.record('clueIncompatible', childMass);
                continue;
            }

            shares.push({
                childId: edge.childId,
                mass: childMass
            });
        }

        const newResidueMass = nextResidueNumerator / totalWeight;
        this.setForwardingResidues(graphId, nodeId, hasResidue ? nextResidues : undefined);
        this.recordResidueDelta(oldResidueMass, newResidueMass);
        this.recordResiduePromotion(assigned - standaloneAssigned);

        for (const share of shares) {
            this.pushPending(graphId, share.childId, share.mass);
        }
    }

    private getPendingEntries(): PendingFrontierEntry[] {
        const entries: PendingFrontierEntry[] = [];
        this.frontier.forEach((graphId, nodeId, mass) => {
            const graph = this.getGraphById(graphId).graph;
            entries.push(Object.freeze({
                graphId,
                nodeId,
                mass,
                combo: graph.getNodeCombo(nodeId),
                count: graph.getNodeCount(nodeId)
            }));
        });
        return entries;
    }

    private getActiveResidueStats(): { count: number; mass: bigint } {
        let count = 0;
        let mass = 0n;
        for (let graphId = 0; graphId < this.forwardingResidues.length; graphId++) {
            const graphResidues = this.forwardingResidues[graphId];
            if (!graphResidues) continue;
            const graph = this.getGraphById(graphId).graph;
            for (const [nodeId, residues] of graphResidues) {
                let residueNumerator = 0n;
                for (const residue of residues) {
                    if (residue === 0n) continue;
                    count++;
                    residueNumerator += residue;
                }
                if (residueNumerator === 0n) continue;
                const expansion = graph.getExpansion(nodeId as SearchGraphNodeId);
                mass += residueNumerator / BigInt(expansion.totalWeight);
            }
        }
        for (const residue of this.bookRedistributionResidues.values()) {
            if (residue === 0n) continue;
            count++;
            mass += residue;
        }
        return { count, mass };
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

    private getForwardingResidues(graphId: number, nodeId: SearchGraphNodeId): BigUint64Array | undefined {
        return this.forwardingResidues[graphId]?.get(nodeId as number);
    }

    private setForwardingResidues(graphId: number, nodeId: SearchGraphNodeId, residues: BigUint64Array | undefined): void {
        let graphResidues = this.forwardingResidues[graphId];
        if (!graphResidues) {
            if (!residues) return;
            graphResidues = new Map<number, BigUint64Array>();
            this.forwardingResidues[graphId] = graphResidues;
        }

        if (residues) {
            graphResidues.set(nodeId as number, residues);
        } else {
            graphResidues.delete(nodeId as number);
        }
    }

    private calculateForwardingResidueMass(residues: BigUint64Array | undefined, totalWeight: bigint): bigint {
        if (!residues) return 0n;
        let numerator = 0n;
        for (const residue of residues) numerator += residue;
        return numerator / totalWeight;
    }

    private setBookRedistributionResidue(combo: PackedCombo, residue: bigint): void {
        if (residue === 0n) {
            this.bookRedistributionResidues.delete(combo);
            return;
        }
        this.bookRedistributionResidues.set(combo, residue);
    }

    private containsTargetClue(combo: PackedCombo, cluePolicy: ClueSearchPolicy): boolean {
        return cluePolicy.containsTargetClue(combo, this.kernel.registry.indexToEnchant);
    }

    private recordResolved(
        combo: PackedCombo,
        count: number,
        mass: bigint,
        cluePolicy: ClueSearchPolicy | undefined
    ): void {
        if (mass === 0n) return;

        if (cluePolicy && !this.containsTargetClue(combo, cluePolicy)) {
            this.mass.record('clueIncompatible', mass);
            return;
        }

        if (this.kernel.item === 'book' && count > 1) {
            const redistributed = ComboUtils.removeAdditional(combo);
            const divisor = BigInt(redistributed.length);
            if (divisor === 0n) {
                this.mass.record('rounding', mass);
                return;
            }

            const oldResidue = this.bookRedistributionResidues.get(combo) ?? 0n;
            const totalToDistribute = mass + oldResidue;
            const share = totalToDistribute / divisor;
            const assigned = share * divisor;
            const standaloneAssigned = (mass / divisor) * divisor;
            const newResidue = totalToDistribute - assigned;
            this.setBookRedistributionResidue(combo, newResidue);
            this.recordResidueDelta(oldResidue, newResidue);
            this.recordResiduePromotion(assigned - standaloneAssigned);

            let resolved = 0n;
            let clueIncompatible = 0n;
            for (const redistributedCombo of redistributed) {
                if (cluePolicy && !this.containsTargetClue(redistributedCombo, cluePolicy)) {
                    clueIncompatible += share;
                    continue;
                }
                ProbUtils.addItemMass(this.results, redistributedCombo, share);
                resolved += share;
            }
            this.mass.record('resolved', resolved);
            this.mass.record('clueIncompatible', clueIncompatible);
            return;
        }

        if (combo !== 0) ProbUtils.addItemMass(this.results, combo, mass);
        this.mass.record('resolved', mass);
    }

    private pushPending(graphId: number, nodeId: SearchGraphNodeId, mass: bigint): void {
        if (mass === 0n) return;
        const target = this.canonicalizePendingTarget(graphId, nodeId, mass);
        this.frontier.pushOrMerge(target.graphId, target.nodeId, mass);
        this.mass.record('pending', mass);
    }

    private canonicalizePendingTarget(graphId: number, nodeId: SearchGraphNodeId, mass: bigint): PendingTarget {
        if (!this.useSuffixMerging) return { graphId, nodeId };

        const graph = this.getGraphById(graphId).graph;
        const suffixIdentity = graph.getSuffixIdentity(nodeId);
        if (!suffixIdentity) return { graphId, nodeId };

        const key = String(suffixIdentity);
        const existing = this.suffixCanonicalNodes.get(key);
        if (existing) {
            if (existing.graphId !== graphId || existing.nodeId !== nodeId) {
                this.suffixMergeHits++;
                this.suffixMergedPendingMass += mass;
            }
            return existing;
        }

        const target = { graphId, nodeId };
        this.suffixCanonicalNodes.set(key, target);
        this.suffixMergeMisses++;
        return target;
    }

    private graphForPool(pool: SearchPool): GraphRecord {
        const existing = this.graphsBySignature.get(pool.signature);
        if (existing) return existing;

        const initialPool = pool.entries.map(entry => entry.packedEnchant);
        const cluePolicy = this.targetClueId !== undefined
            ? ClueSearchPolicy.create(this.kernel.registry, initialPool, this.targetClueId)
            : undefined;
        const record = Object.freeze({
            id: this.graphs.length,
            graph: this.graphCache && this.useExpansionBlueprints
                ? this.graphCache.getOrCreateGraph(this.kernel, pool, null)
                : new SearchGraph(this.kernel, pool, {
                    blueprintCache: this.localBlueprintCache,
                    useExpansionBlueprints: this.useExpansionBlueprints
                }),
            cluePolicy
        });
        this.graphs.push(record);
        this.graphsBySignature.set(pool.signature, record);
        return record;
    }

    private getGraphById(graphId: number): GraphRecord {
        const record = this.graphs[graphId];
        if (!record) throw new Error(`Unknown search graph ID ${graphId}`);
        return record;
    }
}

interface FrontierGraphStorage {
    masses: BigUint64Array;
    positions: Int32Array;
}

class SearchRunFrontier {
    public static readonly INITIAL_NODE_CAPACITY = 1024;

    private readonly heapGraphIds: number[] = [];
    private readonly heapNodeIds: number[] = [];
    private readonly storages: FrontierGraphStorage[] = [];

    public get size(): number {
        return this.heapNodeIds.length;
    }

    public pushOrMerge(graphId: number, nodeId: SearchGraphNodeId, mass: bigint): void {
        const storage = this.ensureStorage(graphId, nodeId);
        const nodeIndex = nodeId as number;
        const existingIndex = storage.positions[nodeIndex]!;
        if (existingIndex !== -1) {
            storage.masses[nodeIndex]! += mass;
            this.bubbleUp(existingIndex);
            return;
        }

        const heapIndex = this.heapNodeIds.length;
        this.heapGraphIds.push(graphId);
        this.heapNodeIds.push(nodeIndex);
        storage.masses[nodeIndex] = mass;
        storage.positions[nodeIndex] = heapIndex;
        this.bubbleUp(heapIndex);
    }

    public peekMass(): bigint {
        return this.heapNodeIds.length === 0 ? 0n : this.massAt(0);
    }

    public forEach(callback: (graphId: number, nodeId: SearchGraphNodeId, mass: bigint) => void): void {
        for (let i = 0; i < this.heapNodeIds.length; i++) {
            const graphId = this.heapGraphIds[i]!;
            const nodeId = this.heapNodeIds[i]! as SearchGraphNodeId;
            callback(graphId, nodeId, this.getNodeMass(graphId, nodeId as number));
        }
    }

    public pop(out: FrontierPopTarget): boolean {
        if (this.heapNodeIds.length === 0) return false;

        const graphId = this.heapGraphIds[0]!;
        const nodeId = this.heapNodeIds[0]!;
        const storage = this.storages[graphId]!;

        out.graphId = graphId;
        out.nodeId = nodeId as SearchGraphNodeId;
        out.mass = storage.masses[nodeId]!;
        storage.positions[nodeId] = -1;
        storage.masses[nodeId] = 0n;

        const lastGraphId = this.heapGraphIds.pop();
        const lastNodeId = this.heapNodeIds.pop();
        if (this.heapNodeIds.length > 0 && lastGraphId !== undefined && lastNodeId !== undefined) {
            this.heapGraphIds[0] = lastGraphId;
            this.heapNodeIds[0] = lastNodeId;
            this.storages[lastGraphId]!.positions[lastNodeId] = 0;
            this.sinkDown(0);
        }

        return true;
    }

    private bubbleUp(index: number): void {
        let current = index;
        const graphId = this.heapGraphIds[current]!;
        const nodeId = this.heapNodeIds[current]!;
        const mass = this.getNodeMass(graphId, nodeId);

        while (current > 0) {
            const parent = (current - 1) >>> 1;
            if (this.massAt(parent) >= mass) break;
            this.moveHeapEntry(parent, current);
            current = parent;
        }

        this.heapGraphIds[current] = graphId;
        this.heapNodeIds[current] = nodeId;
        this.storages[graphId]!.positions[nodeId] = current;
    }

    private sinkDown(index: number): void {
        let current = index;
        const graphId = this.heapGraphIds[current]!;
        const nodeId = this.heapNodeIds[current]!;
        const mass = this.getNodeMass(graphId, nodeId);

        while (true) {
            const left = (current << 1) + 1;
            if (left >= this.heapNodeIds.length) break;
            const right = left + 1;
            let child = left;
            if (right < this.heapNodeIds.length && this.massAt(right) > this.massAt(left)) {
                child = right;
            }
            if (mass >= this.massAt(child)) break;
            this.moveHeapEntry(child, current);
            current = child;
        }

        this.heapGraphIds[current] = graphId;
        this.heapNodeIds[current] = nodeId;
        this.storages[graphId]!.positions[nodeId] = current;
    }

    private moveHeapEntry(from: number, to: number): void {
        const graphId = this.heapGraphIds[from]!;
        const nodeId = this.heapNodeIds[from]!;
        this.heapGraphIds[to] = graphId;
        this.heapNodeIds[to] = nodeId;
        this.storages[graphId]!.positions[nodeId] = to;
    }

    private massAt(index: number): bigint {
        return this.getNodeMass(this.heapGraphIds[index]!, this.heapNodeIds[index]!);
    }

    private getNodeMass(graphId: number, nodeId: number): bigint {
        return this.storages[graphId]!.masses[nodeId]!;
    }

    private ensureStorage(graphId: number, nodeId: SearchGraphNodeId): FrontierGraphStorage {
        let storage = this.storages[graphId];
        if (!storage) {
            storage = this.createStorage(Math.max(SearchRunFrontier.INITIAL_NODE_CAPACITY, (nodeId as number) + 1));
            this.storages[graphId] = storage;
            return storage;
        }

        if ((nodeId as number) >= storage.masses.length) {
            this.growStorage(storage, (nodeId as number) + 1);
        }
        return storage;
    }

    private createStorage(capacity: number): FrontierGraphStorage {
        const normalized = this.nextPowerOfTwo(capacity);
        const positions = new Int32Array(normalized);
        positions.fill(-1);
        return {
            masses: new BigUint64Array(normalized),
            positions
        };
    }

    private growStorage(storage: FrontierGraphStorage, required: number): void {
        const nextCapacity = this.nextPowerOfTwo(required);
        const nextMasses = new BigUint64Array(nextCapacity);
        nextMasses.set(storage.masses);
        const nextPositions = new Int32Array(nextCapacity);
        nextPositions.fill(-1);
        nextPositions.set(storage.positions);
        storage.masses = nextMasses;
        storage.positions = nextPositions;
    }

    private nextPowerOfTwo(value: number): number {
        let size = 1;
        while (size < value) size <<= 1;
        return size;
    }
}
