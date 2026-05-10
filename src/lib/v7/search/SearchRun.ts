import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { ProbabilityMassAccountant } from '#engine/search/ProbabilityMassAccountant.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { MassAccountingBreakdown } from '#types/mass.js';
import { PackedCombo } from '#types/index.js';
import { ComboUtils, PRECISION, ProbUtils } from '#utils/index.js';
import { RegistryKernel, V7PoolProjection, V7PoolSignature } from '#lib/v7/registry/RegistryKernel.js';
import { SearchProgram, V7ProgramExpansion, V7ProgramNode, V7ProgramNodeId } from '#lib/v7/search/SearchProgram.js';

export interface V7SearchRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
}

export interface V7SearchCheckpointRequest {
    readonly threshold?: number | bigint | undefined;
    readonly maxIterations?: number | undefined;
    /** Stop once resolved mass reaches this absolute fixed-point/number target. */
    readonly targetResolvedMass?: number | bigint | undefined;
    /** Optional internal forward-mass floor. Defaults to 0 so validation can dig into the full tail. */
    readonly probabilityFloor?: number | bigint | undefined;
}

export interface V7SearchRunSnapshot {
    readonly results: ReadonlyMap<PackedCombo, bigint>;
    readonly mass: MassAccountingBreakdown;
    readonly iterations: number;
    readonly pendingCount: number;
    readonly programCount: number;
    readonly seededLevelCount: number;
    readonly fullyResolved: boolean;
}

interface ProgramRecord {
    readonly id: number;
    readonly program: SearchProgram;
}

interface FrontierPopTarget {
    programId: number;
    nodeId: V7ProgramNodeId;
    mass: bigint;
}

/**
 * Minimal V7 single-cell probability flow executor.
 *
 * This is intentionally small: one output cell, no clue conditioning, no worker
 * protocol, and no projection layer. It proves the core V7 premise that modified
 * level mass can be seeded directly into shared lazy programs and expanded by one
 * global weighted frontier.
 */
export class SearchRun {
    public readonly results = new Map<PackedCombo, bigint>();
    public readonly mass = new ProbabilityMassAccountant();

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly programsBySignature = new Map<V7PoolSignature, ProgramRecord>();
    private readonly programs: ProgramRecord[] = [];
    private readonly frontier = new V7RunFrontier();
    private seeded = false;
    private _seededLevelCount = 0;
    private _iterations = 0;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: V7SearchRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
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
            const root = program.program.getRootNode(level);
            this.pushPending(program.id, root.id, rootMass);
            seededMass += rootMass;
            this._seededLevelCount++;
        }

        if (seededMass < PRECISION) this.mass.record('rounding', PRECISION - seededMass);
        if (seededMass > PRECISION) throw new Error(`V7 modified-level distribution overflowed precision by ${seededMass - PRECISION} units.`);
    }

    public searchToCheckpoint(request: V7SearchCheckpointRequest = {}): V7SearchRunSnapshot {
        if (!this.seeded) throw new Error('V7 SearchRun must be seeded before searching.');

        const threshold = ProbUtils.toBigInt(request.threshold ?? ENGINE_LIMITS.DEFAULT_THRESHOLD);
        const maxIterations = request.maxIterations ?? ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED;
        const targetResolvedMass = request.targetResolvedMass !== undefined
            ? ProbUtils.toBigInt(request.targetResolvedMass)
            : undefined;
        const probabilityFloor = request.probabilityFloor !== undefined
            ? ProbUtils.toBigInt(request.probabilityFloor)
            : 0n;
        const current = { programId: 0, nodeId: 0 as V7ProgramNodeId, mass: 0n };

        while (this.frontier.size > 0 && this._iterations < maxIterations) {
            if (targetResolvedMass !== undefined && this.mass.getResolvedMass() >= targetResolvedMass) break;
            if (this.frontier.peekMass() < threshold) break;
            if (!this.frontier.pop(current)) break;

            this.mass.subtract('pending', current.mass);
            this.expand(current.programId, current.nodeId, current.mass, probabilityFloor);
            this._iterations++;
        }

        return this.snapshot();
    }

    public snapshot(): V7SearchRunSnapshot {
        return Object.freeze({
            results: new Map(this.results),
            mass: this.mass.toPublic(),
            iterations: this._iterations,
            pendingCount: this.frontier.size,
            programCount: this.programs.length,
            seededLevelCount: this._seededLevelCount,
            fullyResolved: this.frontier.size === 0
        });
    }

    private expand(programId: number, nodeId: V7ProgramNodeId, incomingMass: bigint, probabilityFloor: bigint): void {
        const program = this.getProgramById(programId);
        const expansion = program.getExpansion(nodeId);
        const node = program.getNode(nodeId);

        if (expansion.isRoot) {
            this.expandRoot(programId, expansion, incomingMass);
            return;
        }

        this.expandSearchNode(programId, node, expansion, incomingMass, probabilityFloor);
    }

    private expandRoot(programId: number, expansion: V7ProgramExpansion, incomingMass: bigint): void {
        if (expansion.totalWeight <= 0 || expansion.edges.length === 0) {
            this.mass.record('resolved', incomingMass);
            return;
        }

        this.distributeToEdges(programId, expansion, incomingMass);
    }

    private expandSearchNode(
        programId: number,
        node: V7ProgramNode,
        expansion: V7ProgramExpansion,
        incomingMass: bigint,
        probabilityFloor: bigint
    ): void {
        const probStop = ProbUtils.scale(incomingMass, PRECISION - expansion.probContinue);
        const probForward = incomingMass - probStop;

        this.settleResolved(node.combo, node.count, probStop);

        if (probForward === 0n) return;

        if (expansion.terminalReason === 'max-enchants') {
            this.mass.record('overflow', probForward);
            return;
        }

        if (expansion.totalWeight <= 0 || expansion.edges.length === 0) {
            this.settleResolved(node.combo, node.count, probForward);
            return;
        }

        if (probabilityFloor > 0n && probForward < probabilityFloor) {
            this.mass.record('sieved', probForward);
            return;
        }

        this.distributeToEdges(programId, expansion, probForward);
    }

    private distributeToEdges(programId: number, expansion: V7ProgramExpansion, mass: bigint): void {
        const totalWeight = BigInt(expansion.totalWeight);
        let remainder = mass;

        for (const edge of expansion.edges) {
            const childMass = (mass * BigInt(edge.weight)) / totalWeight;
            remainder -= childMass;
            this.pushPending(programId, edge.childId, childMass);
        }

        if (remainder > 0n) this.mass.record('rounding', remainder);
    }

    private settleResolved(combo: PackedCombo, count: number, mass: bigint): void {
        if (mass === 0n) return;

        if (this.kernel.item === 'book' && count > 1) {
            const redistributed = ComboUtils.removeAdditional(combo);
            const divisor = BigInt(redistributed.length);
            if (divisor === 0n) {
                this.mass.record('rounding', mass);
                return;
            }

            let remainder = mass;
            for (const redistributedCombo of redistributed) {
                const share = mass / divisor;
                remainder -= share;
                ProbUtils.addItemMass(this.results, redistributedCombo, share);
            }
            if (remainder > 0n) {
                ProbUtils.addItemMass(this.results, redistributed[0]!, remainder);
            }
            this.mass.record('resolved', mass);
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

        const record = Object.freeze({
            id: this.programs.length,
            program: new SearchProgram(this.kernel, pool)
        });
        this.programs.push(record);
        this.programsBySignature.set(pool.signature, record);
        return record;
    }

    private getProgramById(programId: number): SearchProgram {
        const record = this.programs[programId];
        if (!record) throw new Error(`Unknown V7 search program ID ${programId}`);
        return record.program;
    }
}

interface V7FrontierProgramStorage {
    masses: BigUint64Array;
    positions: Int32Array;
}

class V7RunFrontier {
    private static readonly INITIAL_NODE_CAPACITY = 1024;

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
