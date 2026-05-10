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
        const current = { programId: 0, nodeId: 0 as V7ProgramNodeId, mass: 0n };

        while (this.frontier.size > 0 && this._iterations < maxIterations) {
            if (this.frontier.peekMass() < threshold) break;
            if (!this.frontier.pop(current)) break;

            this.mass.subtract('pending', current.mass);
            this.expand(current.programId, current.nodeId, current.mass);
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

    private expand(programId: number, nodeId: V7ProgramNodeId, incomingMass: bigint): void {
        const program = this.getProgramById(programId);
        const expansion = program.getExpansion(nodeId);
        const node = program.getNode(nodeId);

        if (expansion.isRoot) {
            this.expandRoot(programId, expansion, incomingMass);
            return;
        }

        this.expandSearchNode(programId, node, expansion, incomingMass);
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
        incomingMass: bigint
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

        const floor = ProbUtils.toBigInt(ENGINE_LIMITS.SYSTEM_THRESHOLD_FLOOR);
        if (probForward < floor) {
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

class V7RunFrontier {
    private readonly heap: string[] = [];
    private readonly entries = new Map<string, { programId: number; nodeId: V7ProgramNodeId; mass: bigint; heapIndex: number }>();

    public get size(): number {
        return this.heap.length;
    }

    public pushOrMerge(programId: number, nodeId: V7ProgramNodeId, mass: bigint): void {
        const key = this.key(programId, nodeId);
        const existing = this.entries.get(key);
        if (existing) {
            existing.mass += mass;
            this.bubbleUp(existing.heapIndex);
            return;
        }

        const entry = { programId, nodeId, mass, heapIndex: this.heap.length };
        this.entries.set(key, entry);
        this.heap.push(key);
        this.bubbleUp(entry.heapIndex);
    }

    public peekMass(): bigint {
        const key = this.heap[0];
        if (key === undefined) return 0n;
        return this.entries.get(key)?.mass ?? 0n;
    }

    public pop(out: FrontierPopTarget): boolean {
        const key = this.heap[0];
        if (key === undefined) return false;
        const entry = this.entries.get(key);
        if (!entry) return false;

        out.programId = entry.programId;
        out.nodeId = entry.nodeId;
        out.mass = entry.mass;
        this.entries.delete(key);

        const lastKey = this.heap.pop();
        if (this.heap.length > 0 && lastKey !== undefined && lastKey !== key) {
            this.heap[0] = lastKey;
            this.entries.get(lastKey)!.heapIndex = 0;
            this.sinkDown(0);
        }

        return true;
    }

    private bubbleUp(index: number): void {
        let current = index;
        const key = this.heap[current]!;
        const mass = this.entries.get(key)!.mass;

        while (current > 0) {
            const parent = (current - 1) >>> 1;
            const parentKey = this.heap[parent]!;
            if (this.entries.get(parentKey)!.mass >= mass) break;
            this.heap[current] = parentKey;
            this.entries.get(parentKey)!.heapIndex = current;
            current = parent;
        }

        this.heap[current] = key;
        this.entries.get(key)!.heapIndex = current;
    }

    private sinkDown(index: number): void {
        let current = index;
        const key = this.heap[current]!;
        const mass = this.entries.get(key)!.mass;

        while (true) {
            const left = (current << 1) + 1;
            if (left >= this.heap.length) break;
            const right = left + 1;
            let child = left;
            if (right < this.heap.length && this.massAt(right) > this.massAt(left)) {
                child = right;
            }
            if (mass >= this.massAt(child)) break;
            const childKey = this.heap[child]!;
            this.heap[current] = childKey;
            this.entries.get(childKey)!.heapIndex = current;
            current = child;
        }

        this.heap[current] = key;
        this.entries.get(key)!.heapIndex = current;
    }

    private massAt(index: number): bigint {
        return this.entries.get(this.heap[index]!)!.mass;
    }

    private key(programId: number, nodeId: V7ProgramNodeId): string {
        return `${programId}:${nodeId}`;
    }
}
