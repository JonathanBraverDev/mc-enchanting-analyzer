import { ENGINE_LIMITS } from '#constants/engine.js';
import { PackedCombo } from '#types/index.js';
import { ComboUtils, PRECISION, ProbUtils } from '#utils/index.js';
import { RegistryKernel, PoolEntry, PoolProjection, PoolSignature } from '#lib/search/registry/RegistryKernel.js';

export type ProgramNodeId = number & { readonly __brand: 'ProgramNodeId' };


class NumericNodeIndex {
    private static readonly INITIAL_CAPACITY = 131072;
    private static readonly MAX_LOAD_FACTOR = 0.7;

    private keys: Float64Array;
    private values: Int32Array;
    private used: Uint8Array;
    private mask: number;
    private resizeAt: number;
    private count = 0;

    public constructor(capacity: number = NumericNodeIndex.INITIAL_CAPACITY) {
        const size = NumericNodeIndex.nextPowerOfTwo(capacity);
        this.keys = new Float64Array(size);
        this.values = new Int32Array(size);
        this.values.fill(-1);
        this.used = new Uint8Array(size);
        this.mask = size - 1;
        this.resizeAt = Math.floor(size * NumericNodeIndex.MAX_LOAD_FACTOR);
    }

    public get(key: number): ProgramNodeId | undefined {
        let idx = this.hash(key) & this.mask;

        while (this.used[idx] !== 0) {
            if (this.keys[idx] === key) {
                const value = this.values[idx]!;
                return value === -1 ? undefined : value as ProgramNodeId;
            }
            idx = (idx + 1) & this.mask;
        }

        return undefined;
    }

    public set(key: number, value: ProgramNodeId): void {
        if (this.count >= this.resizeAt) this.grow();
        this.insert(key, value);
    }

    private insert(key: number, value: ProgramNodeId): void {
        let idx = this.hash(key) & this.mask;

        while (this.used[idx] !== 0) {
            if (this.keys[idx] === key) {
                this.values[idx] = value;
                return;
            }
            idx = (idx + 1) & this.mask;
        }

        this.used[idx] = 1;
        this.keys[idx] = key;
        this.values[idx] = value;
        this.count++;
    }

    private grow(): void {
        const oldKeys = this.keys;
        const oldValues = this.values;
        const oldUsed = this.used;
        const nextSize = oldKeys.length * 2;

        this.keys = new Float64Array(nextSize);
        this.values = new Int32Array(nextSize);
        this.values.fill(-1);
        this.used = new Uint8Array(nextSize);
        this.mask = nextSize - 1;
        this.resizeAt = Math.floor(nextSize * NumericNodeIndex.MAX_LOAD_FACTOR);
        this.count = 0;

        for (let i = 0; i < oldKeys.length; i++) {
            if (oldUsed[i] !== 0) this.insert(oldKeys[i]!, oldValues[i]! as ProgramNodeId);
        }
    }

    private hash(key: number): number {
        const low = key >>> 0;
        const high = Math.floor(key / 0x100000000) >>> 0;
        let h = (low ^ Math.imul(high, 0x9E3779B1)) >>> 0;
        h ^= h >>> 16;
        h = Math.imul(h, 0x7FEB352D) >>> 0;
        h ^= h >>> 15;
        h = Math.imul(h, 0x846CA68B) >>> 0;
        return (h ^ (h >>> 16)) >>> 0;
    }

    private static nextPowerOfTwo(value: number): number {
        let size = 1;
        while (size < value) size <<= 1;
        return size;
    }
}

export interface ProgramKey {
    readonly version: string;
    readonly item: string;
    readonly poolSignature: PoolSignature;
    readonly bookMode: 'single-book' | 'multi-book' | 'item';
    readonly clueMode: string | null;
}

export interface ProgramNode {
    readonly id: ProgramNodeId;
    readonly selectedMask: bigint;
    readonly currentLevel: number;
    readonly combo: PackedCombo;
    readonly count: number;
}

export interface ProgramEdge {
    readonly entry: PoolEntry;
    readonly weight: number;
    readonly childId: ProgramNodeId;
}

export type ProgramTerminalReason = 'max-enchants' | 'single-book' | 'no-eligible' | null;

export interface ProgramExpansion {
    readonly nodeId: ProgramNodeId;
    readonly isRoot: boolean;
    readonly probContinue: bigint;
    readonly totalWeight: number;
    readonly eligibleCount: number;
    readonly edges: readonly ProgramEdge[];
    readonly terminalReason: ProgramTerminalReason;
}

/**
 * Immutable/lazy structural search program for one pool signature.
 *
 * The program owns node identity and expansion structure only. It deliberately
 * stores no probability mass; SearchRun will later attach weighted mass vectors
 * to these nodes and can share future work whenever `(programKey, nodeKey)` is
 * identical.
 */
export class SearchProgram {
    public readonly key: ProgramKey;
    public readonly pool: PoolProjection;

    private readonly selectedMasks: bigint[] = [];
    private readonly currentLevels: number[] = [];
    private readonly combos: PackedCombo[] = [];
    private readonly counts: number[] = [];
    private static readonly MAX_NUMERIC_MASK = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 256));

    private readonly numericNodeIndex = new NumericNodeIndex();
    private readonly bigintNodeIndex = new Map<bigint, ProgramNodeId>();
    private readonly expansionCache: Array<ProgramExpansion | undefined> = [];

    public constructor(
        private readonly kernel: RegistryKernel,
        pool: PoolProjection,
        options: { clueMode?: string | null } = {}
    ) {
        this.pool = pool;
        this.key = Object.freeze({
            version: kernel.version,
            item: kernel.item,
            poolSignature: pool.signature,
            bookMode: this.getBookMode(kernel),
            clueMode: options.clueMode ?? null
        });
    }

    public get size(): number {
        return this.combos.length;
    }

    public getRootNode(initialLevel: number): ProgramNode {
        return this.getNode(this.getOrCreateNodeId(0n, initialLevel, 0 as PackedCombo, 0));
    }

    public getNode(id: ProgramNodeId): ProgramNode {
        this.assertNode(id);
        return {
            id,
            selectedMask: this.selectedMasks[id]!,
            currentLevel: this.currentLevels[id]!,
            combo: this.combos[id]!,
            count: this.counts[id]!
        };
    }

    public getNodeCombo(id: ProgramNodeId): PackedCombo {
        this.assertNode(id);
        return this.combos[id]!;
    }

    public getNodeCount(id: ProgramNodeId): number {
        this.assertNode(id);
        return this.counts[id]!;
    }

    public getExpansion(nodeId: ProgramNodeId): ProgramExpansion {
        const cached = this.expansionCache[nodeId];
        if (cached) return cached;

        const expansion = this.counts[nodeId] === 0
            ? this.buildRootExpansion(nodeId)
            : this.buildSearchExpansion(nodeId);
        this.expansionCache[nodeId] = expansion;
        return expansion;
    }

    private buildRootExpansion(nodeId: ProgramNodeId): ProgramExpansion {
        const currentLevel = this.currentLevels[nodeId]!;
        const edges = this.pool.entries.map(entry => ({
            entry,
            weight: entry.weight,
            childId: this.getOrCreateNodeId(entry.idBit, currentLevel, entry.comboIndex as PackedCombo, 1)
        }));

        return {
            nodeId,
            isRoot: true,
            probContinue: PRECISION,
            totalWeight: this.pool.totalWeight,
            eligibleCount: edges.length,
            edges,
            terminalReason: edges.length === 0 ? 'no-eligible' : null
        };
    }

    private buildSearchExpansion(nodeId: ProgramNodeId): ProgramExpansion {
        const selectedMask = this.selectedMasks[nodeId]!;
        const currentLevel = this.currentLevels[nodeId]!;
        const combo = this.combos[nodeId]!;
        const count = this.counts[nodeId]!;
        const terminalReason = this.getTerminalReason(count);
        const probContinue = terminalReason === 'single-book'
            ? 0n
            // currentLevel only drives the chance of another enchantment slot.
            // Eligibility remains fixed by this program's initial pool signature.
            : (ProbUtils.PROB_CONTINUE_TABLE[currentLevel] ?? PRECISION);

        if (terminalReason === 'max-enchants' || terminalReason === 'single-book') {
            return this.createExpansion(nodeId, count, probContinue, [], terminalReason);
        }

        const nextLevel = Math.floor(currentLevel / 2);
        const nextCount = count + 1;
        const edges: ProgramEdge[] = [];
        let totalWeight = 0;

        for (const entry of this.pool.entries) {
            if ((selectedMask & entry.idBit) !== 0n) continue;
            if ((selectedMask & entry.conflictBitset) !== 0n) continue;

            const childMask = selectedMask | entry.idBit;
            const childCombo = ComboUtils.packAppendIndex(combo, entry.comboIndex, count);
            const childId = this.getOrCreateNodeId(childMask, nextLevel, childCombo, nextCount);
            totalWeight += entry.weight;
            edges.push({
                entry,
                weight: entry.weight,
                childId
            });
        }

        return this.createExpansion(nodeId, count, probContinue, edges, edges.length === 0 ? 'no-eligible' : null, totalWeight);
    }

    private createExpansion(
        nodeId: ProgramNodeId,
        count: number,
        probContinue: bigint,
        edges: readonly ProgramEdge[],
        terminalReason: ProgramTerminalReason,
        totalWeight = edges.reduce((sum, edge) => sum + edge.weight, 0)
    ): ProgramExpansion {
        return {
            nodeId,
            isRoot: count === 0,
            probContinue,
            totalWeight,
            eligibleCount: edges.length,
            edges,
            terminalReason
        };
    }

    private getOrCreateNodeId(
        selectedMask: bigint,
        currentLevel: number,
        combo: PackedCombo,
        count: number
    ): ProgramNodeId {
        const numericKey = this.createNumericNodeKey(selectedMask, currentLevel);
        if (numericKey !== undefined) {
            const existing = this.numericNodeIndex.get(numericKey);
            if (existing !== undefined) return existing;
        } else {
            const key = this.createBigIntNodeKey(selectedMask, currentLevel);
            const existing = this.bigintNodeIndex.get(key);
            if (existing !== undefined) return existing;
        }

        const nodeId = this.combos.length as ProgramNodeId;
        this.selectedMasks.push(selectedMask);
        this.currentLevels.push(currentLevel);
        this.combos.push(combo);
        this.counts.push(count);
        this.expansionCache.push(undefined);
        if (numericKey !== undefined) {
            this.numericNodeIndex.set(numericKey, nodeId);
        } else {
            this.bigintNodeIndex.set(this.createBigIntNodeKey(selectedMask, currentLevel), nodeId);
        }
        return nodeId;
    }

    private createNumericNodeKey(selectedMask: bigint, currentLevel: number): number | undefined {
        if (selectedMask > SearchProgram.MAX_NUMERIC_MASK) return undefined;
        return Number(selectedMask) * 256 + currentLevel;
    }

    private createBigIntNodeKey(selectedMask: bigint, currentLevel: number): bigint {
        return (selectedMask << 8n) | BigInt(currentLevel);
    }

    private getTerminalReason(count: number): ProgramTerminalReason {
        if (this.kernel.item === 'book' && !this.kernel.multiEnchantBooks && count >= 1) {
            return 'single-book';
        }
        if (count >= ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM) {
            return 'max-enchants';
        }
        return null;
    }

    private assertNode(id: ProgramNodeId): void {
        if (id < 0 || id >= this.combos.length) {
            throw new Error(`Unknown search program node ${id}`);
        }
    }

    private getBookMode(kernel: RegistryKernel): ProgramKey['bookMode'] {
        if (kernel.item !== 'book') return 'item';
        return kernel.multiEnchantBooks ? 'multi-book' : 'single-book';
    }
}
