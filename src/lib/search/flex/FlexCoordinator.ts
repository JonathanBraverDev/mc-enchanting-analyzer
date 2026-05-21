import { ProbabilityMassAccountant, SEARCH_MASS_BUCKET, SEARCH_MASS_OPERATION } from '#engine/search/ProbabilityMassAccountant.js';
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
import { FLEX_HASH_CONSTANTS, FLEX_INDEX_LIMITS, FLEX_INDEX_SENTINELS } from '#lib/search/flex/FlexConstants.js';

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

interface FlexResidueStats {
    readonly count: number;
    readonly mass: bigint;
}

export class FlexCoordinator {
    public readonly results = new Map<FlexProgramId, bigint>();
    public readonly mass = new ProbabilityMassAccountant();
    private readonly seedMass = this.mass.forSearchOperation(SEARCH_MASS_OPERATION.Seed);
    private readonly frontierMass = this.mass.forSearchOperation(SEARCH_MASS_OPERATION.Frontier);
    private readonly resolveMass = this.mass.forSearchOperation(SEARCH_MASS_OPERATION.Resolve);
    private readonly edgeSplitMass = this.mass.forSearchOperation(SEARCH_MASS_OPERATION.EdgeSplit);
    private readonly cluePruneMass = this.mass.forSearchOperation(SEARCH_MASS_OPERATION.CluePrune);
    private readonly probabilityFloorMass = this.mass.forSearchOperation(SEARCH_MASS_OPERATION.ProbabilityFloor);
    private readonly overflowMass = this.mass.forSearchOperation(SEARCH_MASS_OPERATION.Overflow);
    private readonly residueMass = this.mass.forSearchOperation(SEARCH_MASS_OPERATION.Residue);

    private readonly frontier = new FlexFrontier();
    private readonly workItem: FlexWorkItem = { graphId: 0, nodeId: 0 as FlexNodeId, mass: 0n };
    private readonly forwardingResidues: Array<Map<number, BigUint64Array> | undefined> = [];
    private _iterations = 0;
    private _lastExpandedMass = 0n;
    private _exitReason: EngineExitReason | undefined;

    public constructor(private readonly graphs: readonly FlexGraph[]) {}

    public seedPending(graphId: number, nodeId: FlexNodeId, mass: bigint): void {
        this.assertGraph(graphId);
        if (mass === 0n) return;
        this.frontier.pushOrMerge(graphId, nodeId, mass);
        this.seedMass.record(SEARCH_MASS_BUCKET.Pending, mass);
    }

    public recordSeedClueIncompatible(mass: bigint): void {
        this.seedMass.record(SEARCH_MASS_BUCKET.ClueIncompatible, mass);
    }

    public recordSeedRounding(mass: bigint): void {
        this.seedMass.record(SEARCH_MASS_BUCKET.Rounding, mass);
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
            massDetails: this.mass.toPublicDetails(),
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
        if (!this.frontier.pop(this.workItem)) return false;

        this.frontierMass.subtract(SEARCH_MASS_BUCKET.Pending, this.workItem.mass);
        this._lastExpandedMass = this.workItem.mass;
        this.expand(this.workItem, criteria.probabilityFloor);
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
            this.overflowMass.record(SEARCH_MASS_BUCKET.Overflow, probForward);
            return;
        }

        if (expansion.totalWeight <= 0 || expansion.edges.length === 0) {
            this.recordResolved(expansion.node.programId, probForward);
            return;
        }

        if (expansion.node.count > 0 && probabilityFloor > 0n && probForward < probabilityFloor) {
            this.probabilityFloorMass.record(SEARCH_MASS_BUCKET.Sieved, probForward);
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
        const clueIncompatibleWeight = expansion.clueIncompatibleWeight ?? 0;
        const clueIncompatibleIndex = expansion.edges.length;
        const nextResidues = new BigUint64Array(expansion.edges.length + (clueIncompatibleWeight > 0 ? 1 : 0));
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
            this.pushPending(graphId, edge.childId, childMass);
        }

        if (clueIncompatibleWeight > 0) {
            const weight = BigInt(clueIncompatibleWeight);
            const numerator = (mass * weight) + (oldResidues?.[clueIncompatibleIndex] ?? 0n);
            const childMass = numerator / totalWeight;
            const edgeResidue = numerator - (childMass * totalWeight);
            nextResidues[clueIncompatibleIndex] = edgeResidue;
            nextResidueNumerator += edgeResidue;
            hasResidue ||= edgeResidue !== 0n;
            assigned += childMass;
            standaloneAssigned += (mass * weight) / totalWeight;
            this.cluePruneMass.record(SEARCH_MASS_BUCKET.ClueIncompatible, childMass);
        }

        const newResidueMass = nextResidueNumerator / totalWeight;
        this.setForwardingResidues(graphId, nodeId, hasResidue ? nextResidues : undefined);
        this.recordResidueDelta(oldResidueMass, newResidueMass);
        this.recordResiduePromotion(assigned - standaloneAssigned);
    }

    private recordResolved(programId: FlexProgramId, mass: bigint): void {
        if (mass === 0n) return;
        this.results.set(programId, (this.results.get(programId) ?? 0n) + mass);
        this.resolveMass.record(SEARCH_MASS_BUCKET.Resolved, mass);
    }

    private pushPending(graphId: number, nodeId: FlexNodeId, mass: bigint): void {
        if (mass === 0n) return;
        this.frontier.pushOrMerge(graphId, nodeId, mass);
        this.frontierMass.record(SEARCH_MASS_BUCKET.Pending, mass);
    }

    private getPendingEntries(): FlexPendingEntry[] {
        const entries: FlexPendingEntry[] = [];
        this.frontier.forEach((graphId, nodeId, mass) => {
            const node = this.getGraph(graphId).getNode(nodeId);
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
            this.edgeSplitMass.record(SEARCH_MASS_BUCKET.Rounding, newResidue - oldResidue);
            return;
        }

        if (oldResidue > newResidue) {
            this.edgeSplitMass.subtract(SEARCH_MASS_BUCKET.Rounding, oldResidue - newResidue);
        }
    }

    private recordResiduePromotion(promotedMass: bigint): void {
        if (promotedMass > 0n) this.residueMass.record(SEARCH_MASS_BUCKET.RecoveredRounding, promotedMass);
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

class FlexFrontier {
    private readonly heapGraphIds: number[] = [];
    private readonly heapNodeIds: number[] = [];
    private readonly heapMasses: bigint[] = [];
    private readonly positionsByState = new FlexFrontierPositionIndex();

    public get size(): number {
        return this.heapNodeIds.length;
    }

    public pushOrMerge(graphId: number, nodeId: FlexNodeId, mass: bigint): void {
        if (mass === 0n) return;
        const nodeKey = nodeId as number;
        const positionKey = this.getPositionKey(graphId, nodeId);
        const existingIndex = this.positionsByState.get(positionKey);
        if (existingIndex !== undefined) {
            this.heapMasses[existingIndex] = this.heapMasses[existingIndex]! + mass;
            this.bubbleUp(existingIndex);
            return;
        }

        const index = this.heapNodeIds.length;
        this.heapGraphIds.push(graphId);
        this.heapNodeIds.push(nodeKey);
        this.heapMasses.push(mass);
        this.positionsByState.set(positionKey, index);
        this.bubbleUp(index);
    }

    public peekMass(): bigint {
        return this.heapNodeIds.length === 0 ? 0n : this.heapMasses[0]!;
    }

    public forEach(callback: (graphId: number, nodeId: FlexNodeId, mass: bigint) => void): void {
        for (let index = 0; index < this.heapNodeIds.length; index++) {
            const graphId = this.heapGraphIds[index]!;
            const nodeId = this.heapNodeIds[index]! as FlexNodeId;
            callback(graphId, nodeId, this.heapMasses[index]!);
        }
    }

    public pop(out: FlexWorkItem): boolean {
        if (this.heapNodeIds.length === 0) return false;

        const graphId = this.heapGraphIds[0]!;
        const nodeId = this.heapNodeIds[0]!;
        const mass = this.heapMasses[0]!;
        this.positionsByState.delete(this.getPositionKey(graphId, nodeId as FlexNodeId));
        out.graphId = graphId;
        out.nodeId = nodeId as FlexNodeId;
        out.mass = mass;

        const lastGraphId = this.heapGraphIds.pop();
        const lastNodeId = this.heapNodeIds.pop();
        const lastMass = this.heapMasses.pop();
        if (this.heapNodeIds.length > 0 && lastGraphId !== undefined && lastNodeId !== undefined && lastMass !== undefined) {
            this.heapGraphIds[0] = lastGraphId;
            this.heapNodeIds[0] = lastNodeId;
            this.heapMasses[0] = lastMass;
            this.sinkDown(0);
        }

        return true;
    }

    private bubbleUp(index: number): void {
        let current = index;
        const graphId = this.heapGraphIds[current]!;
        const nodeId = this.heapNodeIds[current]!;
        const mass = this.heapMasses[current]!;

        while (current > 0) {
            const parent = (current - 1) >>> 1;
            if (this.heapMasses[parent]! >= mass) break;
            this.moveHeapEntry(parent, current);
            current = parent;
        }

        this.heapGraphIds[current] = graphId;
        this.heapNodeIds[current] = nodeId;
        this.heapMasses[current] = mass;
        this.positionsByState.set(this.getPositionKey(graphId, nodeId as FlexNodeId), current);
    }

    private sinkDown(index: number): void {
        let current = index;
        const graphId = this.heapGraphIds[current]!;
        const nodeId = this.heapNodeIds[current]!;
        const mass = this.heapMasses[current]!;

        while (true) {
            const left = (current << 1) + 1;
            if (left >= this.heapNodeIds.length) break;
            const right = left + 1;
            let child = left;
            if (right < this.heapNodeIds.length && this.heapMasses[right]! > this.heapMasses[left]!) {
                child = right;
            }
            if (mass >= this.heapMasses[child]!) break;
            this.moveHeapEntry(child, current);
            current = child;
        }

        this.heapGraphIds[current] = graphId;
        this.heapNodeIds[current] = nodeId;
        this.heapMasses[current] = mass;
        this.positionsByState.set(this.getPositionKey(graphId, nodeId as FlexNodeId), current);
    }

    private moveHeapEntry(from: number, to: number): void {
        const graphId = this.heapGraphIds[from]!;
        const nodeId = this.heapNodeIds[from]!;
        this.heapGraphIds[to] = graphId;
        this.heapNodeIds[to] = nodeId;
        this.heapMasses[to] = this.heapMasses[from]!;
        this.positionsByState.set(this.getPositionKey(graphId, nodeId as FlexNodeId), to);
    }

    private getPositionKey(graphId: number, nodeId: FlexNodeId): number {
        return pairIntegers(graphId, nodeId as number);
    }
}

class FlexFrontierPositionIndex {
    private keys: Float64Array;
    private values: Int32Array;
    private states: Uint8Array;
    private mask: number;
    private resizeAt: number;
    private occupied = 0;
    private used = 0;

    public constructor(capacity: number = FLEX_INDEX_LIMITS.FRONTIER_INITIAL_CAPACITY) {
        const size = FlexFrontierPositionIndex.nextPowerOfTwo(capacity);
        this.keys = new Float64Array(size);
        this.values = new Int32Array(size);
        this.values.fill(FLEX_INDEX_SENTINELS.MISSING_VALUE);
        this.states = new Uint8Array(size);
        this.mask = size - 1;
        this.resizeAt = Math.floor(size * FLEX_INDEX_LIMITS.FRONTIER_MAX_LOAD_FACTOR);
    }

    public get(key: number): number | undefined {
        let index = this.hash(key) & this.mask;
        while (this.states[index] !== FLEX_INDEX_SENTINELS.EMPTY_SLOT) {
            if (this.states[index] === FLEX_INDEX_SENTINELS.OCCUPIED_SLOT && this.keys[index] === key) {
                const value = this.values[index]!;
                return value === FLEX_INDEX_SENTINELS.MISSING_VALUE ? undefined : value;
            }
            index = (index + 1) & this.mask;
        }
        return undefined;
    }

    public set(key: number, value: number): void {
        if (this.used >= this.resizeAt) this.grow();
        this.insert(key, value);
    }

    public delete(key: number): void {
        let index = this.hash(key) & this.mask;
        while (this.states[index] !== FLEX_INDEX_SENTINELS.EMPTY_SLOT) {
            if (this.states[index] === FLEX_INDEX_SENTINELS.OCCUPIED_SLOT && this.keys[index] === key) {
                this.states[index] = FLEX_INDEX_SENTINELS.DELETED_SLOT;
                this.values[index] = FLEX_INDEX_SENTINELS.MISSING_VALUE;
                this.occupied--;
                return;
            }
            index = (index + 1) & this.mask;
        }
    }

    private insert(key: number, value: number): void {
        let index = this.hash(key) & this.mask;
        let firstDeleted: number = FLEX_INDEX_SENTINELS.MISSING_VALUE;

        while (this.states[index] !== FLEX_INDEX_SENTINELS.EMPTY_SLOT) {
            if (this.states[index] === FLEX_INDEX_SENTINELS.OCCUPIED_SLOT && this.keys[index] === key) {
                this.values[index] = value;
                return;
            }
            if (firstDeleted === FLEX_INDEX_SENTINELS.MISSING_VALUE && this.states[index] === FLEX_INDEX_SENTINELS.DELETED_SLOT) firstDeleted = index;
            index = (index + 1) & this.mask;
        }

        const target = firstDeleted === FLEX_INDEX_SENTINELS.MISSING_VALUE ? index : firstDeleted;
        if (this.states[target] === FLEX_INDEX_SENTINELS.EMPTY_SLOT) this.used++;
        this.states[target] = FLEX_INDEX_SENTINELS.OCCUPIED_SLOT;
        this.keys[target] = key;
        this.values[target] = value;
        this.occupied++;
    }

    private grow(): void {
        const oldKeys = this.keys;
        const oldValues = this.values;
        const oldStates = this.states;
        const nextSize = this.occupied >= this.resizeAt
            ? oldKeys.length * FLEX_INDEX_LIMITS.GROWTH_FACTOR
            : oldKeys.length;

        this.keys = new Float64Array(nextSize);
        this.values = new Int32Array(nextSize);
        this.values.fill(FLEX_INDEX_SENTINELS.MISSING_VALUE);
        this.states = new Uint8Array(nextSize);
        this.mask = nextSize - 1;
        this.resizeAt = Math.floor(nextSize * FLEX_INDEX_LIMITS.FRONTIER_MAX_LOAD_FACTOR);
        this.occupied = 0;
        this.used = 0;

        for (let i = 0; i < oldKeys.length; i++) {
            if (oldStates[i] === FLEX_INDEX_SENTINELS.OCCUPIED_SLOT) this.insert(oldKeys[i]!, oldValues[i]!);
        }
    }

    private hash(key: number): number {
        const low = key >>> 0;
        const high = Math.floor(key / FLEX_HASH_U32_BASIS) >>> 0;
        let h = (low ^ Math.imul(high, FLEX_HASH_CONSTANTS.GOLDEN_RATIO_32)) >>> 0;
        h ^= h >>> FLEX_HASH_CONSTANTS.AVALANCHE_SHIFT_1;
        h = Math.imul(h, FLEX_HASH_CONSTANTS.AVALANCHE_MULTIPLIER_1) >>> 0;
        h ^= h >>> FLEX_HASH_CONSTANTS.AVALANCHE_SHIFT_2;
        h = Math.imul(h, FLEX_HASH_CONSTANTS.AVALANCHE_MULTIPLIER_2) >>> 0;
        return (h ^ (h >>> FLEX_HASH_CONSTANTS.AVALANCHE_SHIFT_1)) >>> 0;
    }

    private static nextPowerOfTwo(value: number): number {
        let size = 1;
        while (size < value) size <<= 1;
        return size;
    }
}

const FLEX_HASH_U32_BASIS = 0x100000000;

function pairIntegers(left: number, right: number): number {
    const sum = left + right;
    return ((sum * (sum + 1)) / 2) + right;
}
