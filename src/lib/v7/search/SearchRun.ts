import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { ProbabilityMassAccountant } from '#engine/search/ProbabilityMassAccountant.js';
import { ClueSearchPolicy } from '#engine/search/ClueSearchPolicy.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { MassAccountingBreakdown } from '#types/mass.js';
import { PackedCombo } from '#types/index.js';
import { AsyncUtils, ComboUtils, PRECISION, ProbUtils } from '#utils/index.js';
import { RegistryKernel, V7PoolProjection, V7PoolSignature } from '#lib/v7/registry/RegistryKernel.js';
import { SearchProgram, V7ProgramExpansion, V7ProgramNodeId } from '#lib/v7/search/SearchProgram.js';

export interface V7SearchProgramCache {
    getOrCreateProgram(kernel: RegistryKernel, pool: V7PoolProjection, clueMode?: string | null): SearchProgram;
}

export interface V7SearchRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
    readonly targetClueId?: number | undefined;
    readonly programCache?: V7SearchProgramCache | undefined;
}

export interface V7SearchCheckpointRequest {
    readonly threshold?: number | bigint | undefined;
    readonly maxIterations?: number | undefined;
    /** Ignore threshold and iteration cap, searching until the frontier is empty. */
    readonly exhaustive?: boolean | undefined;
    /** Stop once non-pending mass reaches this absolute fixed-point/number target. */
    readonly targetClassifiedMass?: number | bigint | undefined;
    /** Stop once resolved result mass reaches this absolute fixed-point/number target. Internal/specialized use only. */
    readonly targetResolvedMass?: number | bigint | undefined;
    /** Optional internal forward-mass floor. Defaults to 0 so validation can dig into the full tail. */
    readonly probabilityFloor?: number | bigint | undefined;
    readonly signal?: AbortSignal | undefined;
    /** Async search yield cadence. Used by the worker adapter so abort messages can be observed. */
    readonly yieldEveryIterations?: number | undefined;
}

export interface V7PendingFrontierEntry {
    readonly programId: number;
    readonly nodeId: V7ProgramNodeId;
    readonly mass: bigint;
    readonly combo: PackedCombo;
    readonly count: number;
}

export interface V7SearchRunSnapshot {
    readonly results: ReadonlyMap<PackedCombo, bigint>;
    readonly mass: MassAccountingBreakdown;
    readonly iterations: number;
    readonly pendingCount: number;
    readonly largestPendingMass: bigint;
    readonly pendingEntries: readonly V7PendingFrontierEntry[];
    readonly programCount: number;
    readonly seededLevelCount: number;
    readonly activeResidueCount: number;
    readonly activeResidueMass: bigint;
    readonly fullyResolved: boolean;
}

interface ProgramRecord {
    readonly id: number;
    readonly program: SearchProgram;
    readonly cluePolicy?: ClueSearchPolicy | undefined;
}

interface FrontierPopTarget {
    programId: number;
    nodeId: V7ProgramNodeId;
    mass: bigint;
}

interface V7EdgeMassShare {
    readonly childId: V7ProgramNodeId;
    mass: bigint;
}

interface V7AdvanceCriteria {
    readonly threshold: bigint;
    readonly maxIterations: number;
    readonly targetClassifiedMass?: bigint | undefined;
    readonly targetResolvedMass?: bigint | undefined;
    readonly probabilityFloor: bigint;
    readonly signal?: AbortSignal | undefined;
}

/**
 * Minimal V7 single-cell probability flow executor.
 *
 * This is intentionally small: one output cell, optional clue conditioning, no worker
 * protocol, and no projection layer. It proves the core V7 premise that modified
 * level mass can be seeded directly into shared lazy programs and expanded by one
 * global weighted frontier.
 */
export class SearchRun {
    public readonly results = new Map<PackedCombo, bigint>();
    public readonly mass = new ProbabilityMassAccountant();

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly programCache: V7SearchProgramCache | undefined;
    private readonly programsBySignature = new Map<V7PoolSignature, ProgramRecord>();
    private readonly programs: ProgramRecord[] = [];
    private readonly forwardingResidues: BigUint64Array[] = [];
    private readonly targetClueId: number | undefined;
    private readonly frontier = new V7RunFrontier();
    private seeded = false;
    private _seededLevelCount = 0;
    private _iterations = 0;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: V7SearchRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
        this.programCache = options.programCache;
        this.targetClueId = options.targetClueId;
    }

    public seedXp(xp: number): void {
        if (this.seeded) throw new Error('V7 SearchRun can only be seeded once. Create a new run for a new cell.');
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
            const program = this.getProgram(pool);
            if (program.cluePolicy && !program.cluePolicy.isReachableInPool) {
                this.mass.record('clueIncompatible', rootMass);
                seededMass += rootMass;
                this._seededLevelCount++;
                continue;
            }

            const root = program.program.getRootNode(level);
            this.pushPending(program.id, root.id, rootMass);
            seededMass += rootMass;
            this._seededLevelCount++;
        }

        if (seededMass < PRECISION) this.mass.record('rounding', PRECISION - seededMass);
        if (seededMass > PRECISION) throw new Error(`V7 modified-level distribution overflowed precision by ${seededMass - PRECISION} units.`);
    }

    public searchToCheckpoint(request: V7SearchCheckpointRequest = {}): V7SearchRunSnapshot {
        const criteria = this.createAdvanceCriteria(request);
        this.advanceUntilCheckpoint(criteria);
        return this.snapshot();
    }

    public async searchToCheckpointAsync(request: V7SearchCheckpointRequest = {}): Promise<V7SearchRunSnapshot> {
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

    private createAdvanceCriteria(request: V7SearchCheckpointRequest): V7AdvanceCriteria {
        if (!this.seeded) throw new Error('V7 SearchRun must be seeded before searching.');

        return {
            threshold: request.exhaustive ? 0n : ProbUtils.toBigInt(request.threshold ?? ENGINE_LIMITS.DEFAULT_THRESHOLD),
            maxIterations: request.exhaustive ? Number.POSITIVE_INFINITY : request.maxIterations ?? ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED,
            targetClassifiedMass: request.targetClassifiedMass !== undefined
                ? ProbUtils.toBigInt(request.targetClassifiedMass)
                : undefined,
            targetResolvedMass: request.targetResolvedMass !== undefined
                ? ProbUtils.toBigInt(request.targetResolvedMass)
                : undefined,
            probabilityFloor: request.probabilityFloor !== undefined
                ? ProbUtils.toBigInt(request.probabilityFloor)
                : 0n,
            signal: request.signal
        };
    }

    /**
     * Advances live search state until a real checkpoint/final boundary is reached.
     * Optional chunk size is a scheduler budget only; exhausting it yields without
     * materializing an expensive snapshot.
     *
     * @returns true when the requested checkpoint is reached; false when only the chunk budget was exhausted.
     */
    private advanceUntilCheckpoint(criteria: V7AdvanceCriteria, chunkIterations?: number): boolean {
        const current = { programId: 0, nodeId: 0 as V7ProgramNodeId, mass: 0n };
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
            this.expand(current.programId, current.nodeId, current.mass, criteria.probabilityFloor);
            this._iterations++;
            advancedInChunk++;
        }
    }

    public snapshot(): V7SearchRunSnapshot {
        const residue = this.getActiveResidueStats();
        return Object.freeze({
            results: new Map(this.results),
            mass: this.mass.toPublic(),
            iterations: this._iterations,
            pendingCount: this.frontier.size,
            largestPendingMass: this.frontier.peekMass(),
            pendingEntries: Object.freeze(this.getPendingEntries()),
            programCount: this.programs.length,
            seededLevelCount: this._seededLevelCount,
            activeResidueCount: residue.count,
            activeResidueMass: residue.mass,
            fullyResolved: this.frontier.size === 0
        });
    }

    private expand(programId: number, nodeId: V7ProgramNodeId, incomingMass: bigint, probabilityFloor: bigint): void {
        const record = this.getProgramById(programId);
        const { program, cluePolicy } = record;
        const expansion = program.getExpansion(nodeId);

        if (expansion.isRoot) {
            this.expandRoot(programId, nodeId, expansion, incomingMass, cluePolicy);
            return;
        }

        this.expandSearchNode(
            programId,
            nodeId,
            program.getNodeCombo(nodeId),
            program.getNodeCount(nodeId),
            expansion,
            incomingMass,
            probabilityFloor,
            cluePolicy
        );
    }

    private expandRoot(
        programId: number,
        nodeId: V7ProgramNodeId,
        expansion: V7ProgramExpansion,
        incomingMass: bigint,
        cluePolicy: ClueSearchPolicy | undefined
    ): void {
        if (expansion.totalWeight <= 0 || expansion.edges.length === 0) {
            this.mass.record('resolved', incomingMass);
            return;
        }

        this.distributeToEdges(programId, nodeId, expansion, incomingMass, 0 as PackedCombo, cluePolicy);
    }

    private expandSearchNode(
        programId: number,
        nodeId: V7ProgramNodeId,
        combo: PackedCombo,
        count: number,
        expansion: V7ProgramExpansion,
        incomingMass: bigint,
        probabilityFloor: bigint,
        cluePolicy: ClueSearchPolicy | undefined
    ): void {
        const probStop = ProbUtils.scale(incomingMass, PRECISION - expansion.probContinue);
        const probForward = incomingMass - probStop;

        this.settleResolved(combo, count, probStop, cluePolicy);

        if (probForward === 0n) return;

        if (expansion.terminalReason === 'max-enchants') {
            this.mass.record('overflow', probForward);
            return;
        }

        if (expansion.totalWeight <= 0 || expansion.edges.length === 0) {
            this.settleResolved(combo, count, probForward, cluePolicy);
            return;
        }

        if (probabilityFloor > 0n && probForward < probabilityFloor) {
            this.mass.record('sieved', probForward);
            return;
        }

        this.distributeToEdges(programId, nodeId, expansion, probForward, combo, cluePolicy);
    }

    private distributeToEdges(
        programId: number,
        nodeId: V7ProgramNodeId,
        expansion: V7ProgramExpansion,
        mass: bigint,
        combo: PackedCombo,
        cluePolicy: ClueSearchPolicy | undefined
    ): void {
        const totalWeight = BigInt(expansion.totalWeight);
        const oldResidue = this.getForwardingResidue(programId, nodeId);
        const totalToDistribute = mass + oldResidue;
        const shares: V7EdgeMassShare[] = [];
        let assigned = 0n;

        for (const edge of expansion.edges) {
            if (edge.weight <= 0) continue;

            const childMass = (totalToDistribute * BigInt(edge.weight)) / totalWeight;
            assigned += childMass;
            if (cluePolicy && !cluePolicy.canSelectChild(edge.entry.packedEnchant, this.containsTargetClue(combo, cluePolicy))) {
                this.mass.record('clueIncompatible', childMass);
                continue;
            }

            shares.push({
                childId: edge.childId,
                mass: childMass
            });
        }

        const newResidue = totalToDistribute - assigned;
        this.setForwardingResidue(programId, nodeId, newResidue);
        this.recordResidueDelta(oldResidue, newResidue);

        for (const share of shares) {
            this.pushPending(programId, share.childId, share.mass);
        }
    }

    private getPendingEntries(): V7PendingFrontierEntry[] {
        const entries: V7PendingFrontierEntry[] = [];
        this.frontier.forEach((programId, nodeId, mass) => {
            const program = this.getProgramById(programId).program;
            entries.push(Object.freeze({
                programId,
                nodeId,
                mass,
                combo: program.getNodeCombo(nodeId),
                count: program.getNodeCount(nodeId)
            }));
        });
        return entries;
    }

    private getActiveResidueStats(): { count: number; mass: bigint } {
        let count = 0;
        let mass = 0n;
        for (const storage of this.forwardingResidues) {
            if (!storage) continue;
            for (const residue of storage) {
                if (residue === 0n) continue;
                count++;
                mass += residue;
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
            const recovered = oldResidue - newResidue;
            this.mass.subtract('rounding', recovered);
            this.mass.record('recoveredRounding', recovered);
        }
    }

    private getForwardingResidue(programId: number, nodeId: V7ProgramNodeId): bigint {
        const storage = this.forwardingResidues[programId];
        return storage?.[nodeId as number] ?? 0n;
    }

    private setForwardingResidue(programId: number, nodeId: V7ProgramNodeId, residue: bigint): void {
        const nodeIndex = nodeId as number;
        let storage = this.forwardingResidues[programId];

        if (!storage) {
            let capacity = V7RunFrontier.INITIAL_NODE_CAPACITY;
            while (capacity <= nodeIndex) capacity *= 2;
            storage = new BigUint64Array(capacity);
            this.forwardingResidues[programId] = storage;
        } else if (nodeIndex >= storage.length) {
            let capacity = storage.length;
            while (capacity <= nodeIndex) capacity *= 2;
            const expanded = new BigUint64Array(capacity);
            expanded.set(storage);
            storage = expanded;
            this.forwardingResidues[programId] = storage;
        }

        storage[nodeIndex] = residue;
    }

    private containsTargetClue(combo: PackedCombo, cluePolicy: ClueSearchPolicy): boolean {
        return cluePolicy.containsTargetClue(combo, this.kernel.registry.indexToEnchant);
    }

    private settleResolved(
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

            let remainder = mass;
            let resolved = 0n;
            let clueIncompatible = 0n;
            for (const redistributedCombo of redistributed) {
                const share = mass / divisor;
                remainder -= share;
                if (cluePolicy && !this.containsTargetClue(redistributedCombo, cluePolicy)) {
                    clueIncompatible += share;
                    continue;
                }
                ProbUtils.addItemMass(this.results, redistributedCombo, share);
                resolved += share;
            }
            if (remainder > 0n) {
                const first = redistributed[0]!;
                if (cluePolicy && !this.containsTargetClue(first, cluePolicy)) {
                    clueIncompatible += remainder;
                } else {
                    ProbUtils.addItemMass(this.results, first, remainder);
                    resolved += remainder;
                }
            }
            this.mass.record('resolved', resolved);
            this.mass.record('clueIncompatible', clueIncompatible);
            return;
        }

        if (combo !== 0) ProbUtils.addItemMass(this.results, combo, mass);
        this.mass.record('resolved', mass);
    }

    private pushPending(programId: number, nodeId: V7ProgramNodeId, mass: bigint): void {
        if (mass === 0n) return;
        this.frontier.pushOrMerge(programId, nodeId, mass);
        this.mass.record('pending', mass);
    }

    private getProgram(pool: V7PoolProjection): ProgramRecord {
        const existing = this.programsBySignature.get(pool.signature);
        if (existing) return existing;

        const initialPool = pool.entries.map(entry => entry.packedEnchant);
        const cluePolicy = this.targetClueId !== undefined
            ? ClueSearchPolicy.create(this.kernel.registry, initialPool, this.targetClueId)
            : undefined;
        const record = Object.freeze({
            id: this.programs.length,
            program: this.programCache?.getOrCreateProgram(this.kernel, pool, null) ?? new SearchProgram(this.kernel, pool),
            cluePolicy
        });
        this.programs.push(record);
        this.programsBySignature.set(pool.signature, record);
        return record;
    }

    private getProgramById(programId: number): ProgramRecord {
        const record = this.programs[programId];
        if (!record) throw new Error(`Unknown V7 search program ID ${programId}`);
        return record;
    }
}

interface V7FrontierProgramStorage {
    masses: BigUint64Array;
    positions: Int32Array;
}

class V7RunFrontier {
    public static readonly INITIAL_NODE_CAPACITY = 1024;

    private readonly heapProgramIds: number[] = [];
    private readonly heapNodeIds: number[] = [];
    private readonly storages: V7FrontierProgramStorage[] = [];

    public get size(): number {
        return this.heapNodeIds.length;
    }

    public pushOrMerge(programId: number, nodeId: V7ProgramNodeId, mass: bigint): void {
        const storage = this.ensureStorage(programId, nodeId);
        const nodeIndex = nodeId as number;
        const existingIndex = storage.positions[nodeIndex]!;
        if (existingIndex !== -1) {
            storage.masses[nodeIndex]! += mass;
            this.bubbleUp(existingIndex);
            return;
        }

        const heapIndex = this.heapNodeIds.length;
        this.heapProgramIds.push(programId);
        this.heapNodeIds.push(nodeIndex);
        storage.masses[nodeIndex] = mass;
        storage.positions[nodeIndex] = heapIndex;
        this.bubbleUp(heapIndex);
    }

    public peekMass(): bigint {
        return this.heapNodeIds.length === 0 ? 0n : this.massAt(0);
    }

    public forEach(callback: (programId: number, nodeId: V7ProgramNodeId, mass: bigint) => void): void {
        for (let i = 0; i < this.heapNodeIds.length; i++) {
            const programId = this.heapProgramIds[i]!;
            const nodeId = this.heapNodeIds[i]! as V7ProgramNodeId;
            callback(programId, nodeId, this.getNodeMass(programId, nodeId as number));
        }
    }

    public pop(out: FrontierPopTarget): boolean {
        if (this.heapNodeIds.length === 0) return false;

        const programId = this.heapProgramIds[0]!;
        const nodeId = this.heapNodeIds[0]!;
        const storage = this.storages[programId]!;

        out.programId = programId;
        out.nodeId = nodeId as V7ProgramNodeId;
        out.mass = storage.masses[nodeId]!;
        storage.positions[nodeId] = -1;
        storage.masses[nodeId] = 0n;

        const lastProgramId = this.heapProgramIds.pop();
        const lastNodeId = this.heapNodeIds.pop();
        if (this.heapNodeIds.length > 0 && lastProgramId !== undefined && lastNodeId !== undefined) {
            this.heapProgramIds[0] = lastProgramId;
            this.heapNodeIds[0] = lastNodeId;
            this.storages[lastProgramId]!.positions[lastNodeId] = 0;
            this.sinkDown(0);
        }

        return true;
    }

    private bubbleUp(index: number): void {
        let current = index;
        const programId = this.heapProgramIds[current]!;
        const nodeId = this.heapNodeIds[current]!;
        const mass = this.getNodeMass(programId, nodeId);

        while (current > 0) {
            const parent = (current - 1) >>> 1;
            if (this.massAt(parent) >= mass) break;
            this.moveHeapEntry(parent, current);
            current = parent;
        }

        this.heapProgramIds[current] = programId;
        this.heapNodeIds[current] = nodeId;
        this.storages[programId]!.positions[nodeId] = current;
    }

    private sinkDown(index: number): void {
        let current = index;
        const programId = this.heapProgramIds[current]!;
        const nodeId = this.heapNodeIds[current]!;
        const mass = this.getNodeMass(programId, nodeId);

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

        this.heapProgramIds[current] = programId;
        this.heapNodeIds[current] = nodeId;
        this.storages[programId]!.positions[nodeId] = current;
    }

    private moveHeapEntry(from: number, to: number): void {
        const programId = this.heapProgramIds[from]!;
        const nodeId = this.heapNodeIds[from]!;
        this.heapProgramIds[to] = programId;
        this.heapNodeIds[to] = nodeId;
        this.storages[programId]!.positions[nodeId] = to;
    }

    private massAt(index: number): bigint {
        return this.getNodeMass(this.heapProgramIds[index]!, this.heapNodeIds[index]!);
    }

    private getNodeMass(programId: number, nodeId: number): bigint {
        return this.storages[programId]!.masses[nodeId]!;
    }

    private ensureStorage(programId: number, nodeId: V7ProgramNodeId): V7FrontierProgramStorage {
        let storage = this.storages[programId];
        if (!storage) {
            storage = this.createStorage(Math.max(V7RunFrontier.INITIAL_NODE_CAPACITY, (nodeId as number) + 1));
            this.storages[programId] = storage;
            return storage;
        }

        if ((nodeId as number) >= storage.masses.length) {
            this.growStorage(storage, (nodeId as number) + 1);
        }
        return storage;
    }

    private createStorage(capacity: number): V7FrontierProgramStorage {
        const normalized = this.nextPowerOfTwo(capacity);
        const positions = new Int32Array(normalized);
        positions.fill(-1);
        return {
            masses: new BigUint64Array(normalized),
            positions
        };
    }

    private growStorage(storage: V7FrontierProgramStorage, required: number): void {
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
