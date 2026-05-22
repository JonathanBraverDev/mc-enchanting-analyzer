import { ProbabilityMassAccountant } from '#engine/search/ProbabilityMassAccountant.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import type { EngineExitReason } from '#types/index.js';
import { AsyncUtils, PRECISION, ProbUtils } from '#utils/index.js';
import type {
    FlexCheckpointRequest,
    FlexExpansion,
    FlexGraph,
    FlexNodeId,
    FlexPendingEntry,
    FlexProgramId,
    FlexRunSnapshot
} from '#lib/search/flex/FlexTypes.js';

const SYSTEM_PROBABILITY_FLOOR = ProbUtils.toBigInt(ENGINE_LIMITS.SYSTEM_THRESHOLD_FLOOR);

interface FlexAdvanceCriteria {
    readonly threshold: bigint;
    readonly maxIterations: number;
    readonly drainEqualMassBand: boolean;
    readonly targetClassifiedMass: bigint | undefined;
    readonly probabilityFloor: bigint;
    readonly signal?: AbortSignal | undefined;
}

interface FlexWorkItem {
    graphId: number;
    nodeId: FlexNodeId;
    mass: bigint;
}

interface FlexEdgeMassShare {
    readonly childId: FlexNodeId;
    readonly mass: bigint;
}

interface FlexResidueStats {
    readonly count: number;
    readonly mass: bigint;
}

export class FlexCoordinator {
    public readonly results = new Map<FlexProgramId, bigint>();
    public readonly mass = new ProbabilityMassAccountant();

    private readonly frontier = new FlexFrontier();
    private readonly forwardingResidues: Array<Map<number, BigUint64Array> | undefined> = [];
    private _iterations = 0;
    private _lastExpandedMass = 0n;
    private _exitReason: EngineExitReason | undefined;

    public constructor(private readonly graphs: readonly FlexGraph[]) {}

    public seedPending(graphId: number, nodeId: FlexNodeId, mass: bigint): void {
        this.assertGraph(graphId);
        if (mass === 0n) return;
        this.frontier.pushOrMerge(graphId, nodeId, mass);
        this.mass.record('pending', mass);
    }

    public searchToCheckpoint(request: FlexCheckpointRequest = {}): FlexRunSnapshot {
        const criteria = this.createAdvanceCriteria(request);
        this.advanceUntilCheckpoint(criteria);
        return this.snapshot();
    }

    public async searchToCheckpointAsync(request: FlexCheckpointRequest = {}): Promise<FlexRunSnapshot> {
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

    public snapshot(): FlexRunSnapshot {
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
            activeResidueCount: residue.count,
            activeResidueMass: residue.mass,
            fullyResolved: this.frontier.size === 0,
            exitReason: this.frontier.size === 0 ? 'empty' : this._exitReason
        });
    }

    private createAdvanceCriteria(request: FlexCheckpointRequest): FlexAdvanceCriteria {
        if (request.maxIterations !== undefined) this.validateMaxIterations(request.maxIterations);
        this.validateProbabilityInput(request.threshold, 'threshold', 'Threshold must be between 0 and 1.0.');
        this.validateProbabilityInput(request.targetClassifiedMass, 'targetClassifiedMass', 'Must be between 0 and 1.0.');
        this.validateProbabilityInput(request.probabilityFloor, 'probabilityFloor', 'Must be between 0 and 1.0.');

        const targetClassifiedMass = request.targetClassifiedMass === undefined
            ? undefined
            : ProbUtils.toBigInt(request.targetClassifiedMass);
        const threshold = request.exhaustive ? 0n : ProbUtils.toBigInt(request.threshold ?? 0n);
        const maxIterations = request.exhaustive
            ? Number.POSITIVE_INFINITY
            : request.maxIterations ?? Number.POSITIVE_INFINITY;
        const probabilityFloor = request.exhaustive
            ? 0n
            : request.probabilityFloor !== undefined
                ? ProbUtils.toBigInt(request.probabilityFloor)
                : SYSTEM_PROBABILITY_FLOOR;
        const hasBoundedStopCondition = targetClassifiedMass !== undefined
            || (request.threshold !== undefined && threshold > 0n)
            || request.maxIterations !== undefined;

        if (!request.exhaustive && !hasBoundedStopCondition) {
            throw new Error('FlexCoordinator has no bounded stop condition. Provide a positive threshold, a finite maxIterations, a mass target, or set exhaustive: true.');
        }

        return {
            threshold,
            maxIterations,
            drainEqualMassBand: request.exhaustive ? false : request.drainEqualMassBand === true,
            targetClassifiedMass,
            probabilityFloor,
            signal: request.signal
        };
    }

    private advanceUntilCheckpoint(criteria: FlexAdvanceCriteria, chunkIterations?: number): boolean {
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
            if (!this.step(criteria)) {
                this._exitReason = 'empty';
                return true;
            }
            advancedInChunk++;
        }
    }

    private getExitReason(criteria: FlexAdvanceCriteria): EngineExitReason | undefined {
        if (this.frontier.size === 0) return 'empty';
        if (criteria.targetClassifiedMass !== undefined && this.mass.getClassifiedMass() >= criteria.targetClassifiedMass) return 'mass';
        if (this.frontier.peekMass() < criteria.threshold) return 'threshold';
        if (this.hasReachedIterationStop(criteria)) return 'iterations';
        return undefined;
    }

    private hasReachedIterationStop(criteria: FlexAdvanceCriteria): boolean {
        if (this._iterations < criteria.maxIterations) return false;
        if (!criteria.drainEqualMassBand) return true;
        if (this._lastExpandedMass === 0n) return true;
        return this.frontier.peekMass() < this._lastExpandedMass;
    }

    private step(criteria: FlexAdvanceCriteria): boolean {
        const current: FlexWorkItem = { graphId: 0, nodeId: 0 as FlexNodeId, mass: 0n };
        if (!this.frontier.pop(current)) return false;

        this.mass.subtract('pending', current.mass);
        this._lastExpandedMass = current.mass;
        this.expand(current, criteria.probabilityFloor);
        this._iterations++;
        return true;
    }

    private expand(current: FlexWorkItem, probabilityFloor: bigint): void {
        const expansion = this.getGraph(current.graphId).getExpansion(current.nodeId);

        if (expansion.node.count === 0 && (expansion.totalWeight <= 0 || expansion.edges.length === 0)) {
            this.recordResolved(expansion.node.programId, current.mass);
            return;
        }

        const probStop = ProbUtils.scale(current.mass, PRECISION - expansion.probContinue);
        const probForward = current.mass - probStop;
        this.recordResolved(expansion.node.programId, probStop);

        if (probForward === 0n) return;
        if (expansion.terminalReason === 'overflow') {
            this.mass.record('overflow', probForward);
            return;
        }

        if (expansion.totalWeight <= 0 || expansion.edges.length === 0) {
            this.recordResolved(expansion.node.programId, probForward);
            return;
        }

        if (expansion.node.count > 0 && probabilityFloor > 0n && probForward < probabilityFloor) {
            this.mass.record('sieved', probForward);
            return;
        }

        this.forwardMass(current.graphId, current.nodeId, expansion, probForward);
    }

    private forwardMass(
        graphId: number,
        nodeId: FlexNodeId,
        expansion: FlexExpansion,
        mass: bigint
    ): void {
        const totalWeight = BigInt(expansion.totalWeight);
        const oldResidues = this.getForwardingResidues(graphId, nodeId);
        const oldResidueMass = this.calculateForwardingResidueMass(oldResidues, totalWeight);
        const nextResidues = new BigUint64Array(expansion.edges.length);
        const shares: FlexEdgeMassShare[] = [];
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
            shares.push({ childId: edge.childId, mass: childMass });
        }

        const newResidueMass = nextResidueNumerator / totalWeight;
        this.setForwardingResidues(graphId, nodeId, hasResidue ? nextResidues : undefined);
        this.recordResidueDelta(oldResidueMass, newResidueMass);
        this.recordResiduePromotion(assigned - standaloneAssigned);

        for (const share of shares) {
            this.pushPending(graphId, share.childId, share.mass);
        }
    }

    private recordResolved(programId: FlexProgramId, mass: bigint): void {
        if (mass === 0n) return;
        this.results.set(programId, (this.results.get(programId) ?? 0n) + mass);
        this.mass.record('resolved', mass);
    }

    private pushPending(graphId: number, nodeId: FlexNodeId, mass: bigint): void {
        if (mass === 0n) return;
        this.frontier.pushOrMerge(graphId, nodeId, mass);
        this.mass.record('pending', mass);
    }

    private getPendingEntries(): FlexPendingEntry[] {
        const entries: FlexPendingEntry[] = [];
        this.frontier.forEach((graphId, nodeId, mass) => {
            const node = this.getGraph(graphId).getExpansion(nodeId).node;
            entries.push(Object.freeze({
                graphId,
                nodeId,
                programId: node.programId,
                mass,
                count: node.count,
                nodeKind: node.kind
            }));
        });
        return entries;
    }

    private getActiveResidueStats(): FlexResidueStats {
        let count = 0;
        let mass = 0n;
        for (let graphId = 0; graphId < this.forwardingResidues.length; graphId++) {
            const graphResidues = this.forwardingResidues[graphId];
            if (!graphResidues) continue;
            const graph = this.getGraph(graphId);
            for (const [nodeId, residues] of graphResidues) {
                let residueNumerator = 0n;
                for (const residue of residues) {
                    if (residue === 0n) continue;
                    count++;
                    residueNumerator += residue;
                }
                if (residueNumerator === 0n) continue;
                const expansion = graph.getExpansion(nodeId as FlexNodeId);
                mass += residueNumerator / BigInt(expansion.totalWeight);
            }
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

    private getForwardingResidues(graphId: number, nodeId: FlexNodeId): BigUint64Array | undefined {
        return this.forwardingResidues[graphId]?.get(nodeId as number);
    }

    private setForwardingResidues(graphId: number, nodeId: FlexNodeId, residues: BigUint64Array | undefined): void {
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

    private validateMaxIterations(maxIterations: number): void {
        if (!Number.isFinite(maxIterations) || !Number.isInteger(maxIterations) || maxIterations <= 0) {
            throw new Error(`Invalid maxIterations: ${maxIterations}. Must be a positive integer.`);
        }
    }

    private validateProbabilityInput(value: number | bigint | undefined, label: string, requirement: string): void {
        if (value === undefined) return;
        const normalized = ProbUtils.toNumber(value);
        if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1.0) {
            throw new Error(`Invalid ${label}: ${normalized}. ${requirement}`);
        }
    }

    private getGraph(graphId: number): FlexGraph {
        this.assertGraph(graphId);
        return this.graphs[graphId]!;
    }

    private assertGraph(graphId: number): void {
        if (!Number.isInteger(graphId) || graphId < 0 || graphId >= this.graphs.length) {
            throw new Error(`Unknown Flex graph ID ${graphId}.`);
        }
    }
}

interface FlexFrontierStorage {
    readonly masses: Map<number, bigint>;
}

class FlexFrontier {
    private readonly heapGraphIds: number[] = [];
    private readonly heapNodeIds: number[] = [];
    private readonly storages: FlexFrontierStorage[] = [];

    public get size(): number {
        return this.heapNodeIds.length;
    }

    public pushOrMerge(graphId: number, nodeId: FlexNodeId, mass: bigint): void {
        if (mass === 0n) return;
        const storage = this.ensureStorage(graphId);
        const nodeKey = nodeId as number;
        const existingMass = storage.masses.get(nodeKey) ?? 0n;
        storage.masses.set(nodeKey, existingMass + mass);

        const existingIndex = this.findHeapIndex(graphId, nodeId);
        if (existingIndex !== undefined) {
            this.bubbleUp(existingIndex);
            return;
        }

        const index = this.heapNodeIds.length;
        this.heapGraphIds.push(graphId);
        this.heapNodeIds.push(nodeKey);
        this.bubbleUp(index);
    }

    public peekMass(): bigint {
        return this.heapNodeIds.length === 0 ? 0n : this.getHeapMass(0);
    }

    public forEach(callback: (graphId: number, nodeId: FlexNodeId, mass: bigint) => void): void {
        for (let index = 0; index < this.heapNodeIds.length; index++) {
            const graphId = this.heapGraphIds[index]!;
            const nodeId = this.heapNodeIds[index]! as FlexNodeId;
            callback(graphId, nodeId, this.getNodeMass(graphId, nodeId));
        }
    }

    public pop(out: FlexWorkItem): boolean {
        if (this.heapNodeIds.length === 0) return false;

        const graphId = this.heapGraphIds[0]!;
        const nodeId = this.heapNodeIds[0]!;
        const mass = this.getNodeMass(graphId, nodeId as FlexNodeId);
        this.storages[graphId]!.masses.delete(nodeId);
        out.graphId = graphId;
        out.nodeId = nodeId as FlexNodeId;
        out.mass = mass;

        const lastGraphId = this.heapGraphIds.pop();
        const lastNodeId = this.heapNodeIds.pop();
        if (this.heapNodeIds.length > 0 && lastGraphId !== undefined && lastNodeId !== undefined) {
            this.heapGraphIds[0] = lastGraphId;
            this.heapNodeIds[0] = lastNodeId;
            this.sinkDown(0);
        }

        return true;
    }

    private bubbleUp(index: number): void {
        let current = index;
        const graphId = this.heapGraphIds[current]!;
        const nodeId = this.heapNodeIds[current]!;

        while (current > 0) {
            const parent = (current - 1) >>> 1;
            if (this.getHeapMass(parent) >= this.getNodeMass(graphId, nodeId as FlexNodeId)) break;
            this.moveHeapEntry(parent, current);
            current = parent;
        }

        this.heapGraphIds[current] = graphId;
        this.heapNodeIds[current] = nodeId;
    }

    private sinkDown(index: number): void {
        let current = index;
        const graphId = this.heapGraphIds[current]!;
        const nodeId = this.heapNodeIds[current]!;
        const mass = this.getNodeMass(graphId, nodeId as FlexNodeId);

        while (true) {
            const left = (current << 1) + 1;
            if (left >= this.heapNodeIds.length) break;
            const right = left + 1;
            let child = left;
            if (right < this.heapNodeIds.length && this.getHeapMass(right) > this.getHeapMass(left)) {
                child = right;
            }
            if (mass >= this.getHeapMass(child)) break;
            this.moveHeapEntry(child, current);
            current = child;
        }

        this.heapGraphIds[current] = graphId;
        this.heapNodeIds[current] = nodeId;
    }

    private moveHeapEntry(from: number, to: number): void {
        this.heapGraphIds[to] = this.heapGraphIds[from]!;
        this.heapNodeIds[to] = this.heapNodeIds[from]!;
    }

    private findHeapIndex(graphId: number, nodeId: FlexNodeId): number | undefined {
        const nodeKey = nodeId as number;
        for (let index = 0; index < this.heapNodeIds.length; index++) {
            if (this.heapGraphIds[index] === graphId && this.heapNodeIds[index] === nodeKey) return index;
        }
        return undefined;
    }

    private getHeapMass(index: number): bigint {
        return this.getNodeMass(this.heapGraphIds[index]!, this.heapNodeIds[index]! as FlexNodeId);
    }

    private getNodeMass(graphId: number, nodeId: FlexNodeId): bigint {
        return this.storages[graphId]?.masses.get(nodeId as number) ?? 0n;
    }

    private ensureStorage(graphId: number): FlexFrontierStorage {
        let storage = this.storages[graphId];
        if (!storage) {
            storage = { masses: new Map<number, bigint>() };
            this.storages[graphId] = storage;
        }
        return storage;
    }
}
