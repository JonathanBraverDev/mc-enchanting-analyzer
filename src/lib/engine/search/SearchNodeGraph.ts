import { ExpansionBlueprint, PackedCombo } from '#types/index.js';

interface ForwardingResidue {
    residue: bigint;
}

class NumericNodeIndex {
    private static readonly INITIAL_CAPACITY = 131072;
    private static readonly MAX_LOAD_FACTOR = 0.7;
    private static readonly UINT32_SCALE = 0x100000000;

    private keys: Float64Array;
    private values: Int32Array;
    private used: Uint8Array;
    private mask: number;
    private resizeAt: number;
    private count = 0;

    constructor(capacity: number = NumericNodeIndex.INITIAL_CAPACITY) {
        const size = NumericNodeIndex.nextPowerOfTwo(capacity);
        this.keys = new Float64Array(size);
        this.values = new Int32Array(size);
        this.values.fill(-1);
        this.used = new Uint8Array(size);
        this.mask = size - 1;
        this.resizeAt = Math.floor(size * NumericNodeIndex.MAX_LOAD_FACTOR);
    }

    public get(key: number): number | undefined {
        let idx = this.hash(key) & this.mask;

        while (this.used[idx] !== 0) {
            if (this.keys[idx] === key) {
                const value = this.values[idx]!;
                return value === -1 ? undefined : value;
            }
            idx = (idx + 1) & this.mask;
        }

        return undefined;
    }

    public set(key: number, value: number): void {
        if (this.count >= this.resizeAt) this.grow();
        this.insert(key, value);
    }

    public clone(): NumericNodeIndex {
        const other = new NumericNodeIndex(this.keys.length);
        other.keys.set(this.keys);
        other.values.set(this.values);
        other.used.set(this.used);
        other.mask = this.mask;
        other.resizeAt = this.resizeAt;
        other.count = this.count;
        return other;
    }

    private insert(key: number, value: number): void {
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
            if (oldUsed[i] !== 0) this.insert(oldKeys[i]!, oldValues[i]!);
        }
    }

    private hash(key: number): number {
        const low = key >>> 0;
        const high = Math.floor(key / NumericNodeIndex.UINT32_SCALE) >>> 0;
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

/**
 * Dense graph of search nodes for one modified-level search.
 * The frontier can use node IDs while this graph owns node metadata.
 */
export class SearchNodeGraph {
    private static readonly MAX_SAFE_META = BigInt(Number.MAX_SAFE_INTEGER);
    private static readonly ENCHANT_SHIFT = 8n;
    private static readonly LOW_MASK_BITS = 32n;
    private static readonly LOW_MASK = 0xFFFFFFFFn;
    private static readonly NUMERIC_META_STRIDE = 256;
    private static readonly HI_MASK_SCALE = 0x100000000;
    private static readonly INITIAL_EDGE_CAPACITY = 1024;

    private numericKeyToId = new NumericNodeIndex();
    private readonly bigintMetaToId = new Map<bigint, number>();
    private metas: Array<bigint | undefined> = [];
    private maskLos: number[] = [];
    private maskHis: number[] = [];
    private levels: number[] = [];
    private combos: PackedCombo[] = [];
    private counts: number[] = [];
    private blueprints: Array<ExpansionBlueprint | undefined> = [];
    private residues: Array<ForwardingResidue | undefined> = [];
    private edgeChildIds = new Uint32Array(SearchNodeGraph.INITIAL_EDGE_CAPACITY);
    private edgeWeights = new Int32Array(SearchNodeGraph.INITIAL_EDGE_CAPACITY);
    private edgeCount = 0;

    public getOrCreateNode(meta: bigint, combo: PackedCombo, count: number): number {
        if (meta <= SearchNodeGraph.MAX_SAFE_META) {
            const parts = SearchNodeGraph.partsFromMeta(meta);
            return this.getOrCreateNumericNode(parts.maskLo, parts.maskHi, parts.level, combo, count);
        }

        const existing = this.bigintMetaToId.get(meta);
        if (existing !== undefined) return existing;

        const parts = SearchNodeGraph.partsFromMeta(meta);
        const nodeId = this.appendNode(meta, parts.maskLo, parts.maskHi, parts.level, combo, count);
        this.bigintMetaToId.set(meta, nodeId);
        return nodeId;
    }

    public getOrCreateNumericNode(maskLo: number, maskHi: number, level: number, combo: PackedCombo, count: number): number {
        const existing = this.getNumericNodeId(maskLo, maskHi, level);
        if (existing !== undefined) return existing;

        return this.createNumericNode(maskLo, maskHi, level, combo, count);
    }

    public getNumericNodeId(maskLo: number, maskHi: number, level: number): number | undefined {
        const normalizedMaskLo = maskLo >>> 0;
        const normalizedMaskHi = maskHi >>> 0;
        const numericKey = SearchNodeGraph.numericKey(normalizedMaskLo, normalizedMaskHi, level);

        if (numericKey > Number.MAX_SAFE_INTEGER) {
            return undefined;
        }

        return this.numericKeyToId.get(numericKey);
    }

    public createNumericNode(maskLo: number, maskHi: number, level: number, combo: PackedCombo, count: number): number {
        const normalizedMaskLo = maskLo >>> 0;
        const normalizedMaskHi = maskHi >>> 0;
        const numericKey = SearchNodeGraph.numericKey(normalizedMaskLo, normalizedMaskHi, level);

        if (numericKey > Number.MAX_SAFE_INTEGER) {
            return this.getOrCreateNode(SearchNodeGraph.metaFromParts(normalizedMaskLo, normalizedMaskHi, level), combo, count);
        }

        const nodeId = this.appendNode(undefined, normalizedMaskLo, normalizedMaskHi, level, combo, count);
        this.numericKeyToId.set(numericKey, nodeId);
        return nodeId;
    }

    public getMeta(nodeId: number): bigint {
        this.assertNode(nodeId);
        const meta = this.metas[nodeId];
        return meta ?? SearchNodeGraph.metaFromParts(this.maskLos[nodeId]!, this.maskHis[nodeId]!, this.levels[nodeId]!);
    }

    public getMaskLo(nodeId: number): number {
        this.assertNode(nodeId);
        return this.maskLos[nodeId]!;
    }

    public getMaskHi(nodeId: number): number {
        this.assertNode(nodeId);
        return this.maskHis[nodeId]!;
    }

    public getLevel(nodeId: number): number {
        this.assertNode(nodeId);
        return this.levels[nodeId]!;
    }

    public isNumericNode(nodeId: number): boolean {
        this.assertNode(nodeId);
        return this.metas[nodeId] === undefined;
    }

    public getCombo(nodeId: number): PackedCombo {
        const combo = this.combos[nodeId];
        if (combo === undefined) throw new Error(`Unknown search node ID ${nodeId}`);
        return combo;
    }

    public getCount(nodeId: number): number {
        const count = this.counts[nodeId];
        if (count === undefined) throw new Error(`Unknown search node ID ${nodeId}`);
        return count;
    }

    public hasBlueprint(nodeId: number): boolean {
        return this.blueprints[nodeId] !== undefined;
    }

    public getBlueprint(nodeId: number): ExpansionBlueprint | undefined {
        return this.blueprints[nodeId];
    }

    public setBlueprint(nodeId: number, blueprint: ExpansionBlueprint): void {
        this.assertNode(nodeId);
        this.blueprints[nodeId] = blueprint;
    }

    public getForwardingResidue(nodeId: number): ForwardingResidue {
        this.assertNode(nodeId);
        let residue = this.residues[nodeId];
        if (!residue) {
            residue = { residue: 0n };
            this.residues[nodeId] = residue;
        }
        return residue;
    }

    public beginEdgeSpan(): number {
        return this.edgeCount;
    }

    public appendBlueprintEdge(childId: number, weight: number): void {
        this.ensureEdgeCapacity(this.edgeCount + 1);
        this.edgeChildIds[this.edgeCount] = childId;
        this.edgeWeights[this.edgeCount] = weight;
        this.edgeCount++;
    }

    public getEdgeChildId(edgeIndex: number): number {
        if (edgeIndex < 0 || edgeIndex >= this.edgeCount) {
            throw new Error(`Unknown blueprint edge index ${edgeIndex}`);
        }
        return this.edgeChildIds[edgeIndex]!;
    }

    public getEdgeWeights(): Int32Array {
        return this.edgeWeights;
    }

    public get size(): number {
        return this.combos.length;
    }

    public clone(): SearchNodeGraph {
        const graph = new SearchNodeGraph();
        graph.metas = [...this.metas];
        graph.maskLos = [...this.maskLos];
        graph.maskHis = [...this.maskHis];
        graph.levels = [...this.levels];
        graph.combos = [...this.combos];
        graph.counts = [...this.counts];
        graph.blueprints = [...this.blueprints];
        graph.residues = this.residues.map(residue => residue ? { residue: residue.residue } : undefined);
        graph.edgeChildIds = new Uint32Array(this.edgeChildIds.length);
        graph.edgeChildIds.set(this.edgeChildIds);
        graph.edgeWeights = new Int32Array(this.edgeWeights.length);
        graph.edgeWeights.set(this.edgeWeights);
        graph.edgeCount = this.edgeCount;
        graph.numericKeyToId = this.numericKeyToId.clone();
        for (const [meta, nodeId] of this.bigintMetaToId) {
            graph.bigintMetaToId.set(meta, nodeId);
        }
        return graph;
    }

    private appendNode(
        meta: bigint | undefined,
        maskLo: number,
        maskHi: number,
        level: number,
        combo: PackedCombo,
        count: number
    ): number {
        const nodeId = this.combos.length;
        this.metas.push(meta);
        this.maskLos.push(maskLo);
        this.maskHis.push(maskHi);
        this.levels.push(level);
        this.combos.push(combo);
        this.counts.push(count);
        this.blueprints.push(undefined);
        this.residues.push(undefined);
        return nodeId;
    }

    private static numericKey(maskLo: number, maskHi: number, level: number): number {
        return ((maskHi * SearchNodeGraph.HI_MASK_SCALE) + maskLo) * SearchNodeGraph.NUMERIC_META_STRIDE + level;
    }

    private static partsFromMeta(meta: bigint): { maskLo: number; maskHi: number; level: number } {
        const bitset = meta >> SearchNodeGraph.ENCHANT_SHIFT;
        return {
            maskLo: Number(bitset & SearchNodeGraph.LOW_MASK) >>> 0,
            maskHi: Number((bitset >> SearchNodeGraph.LOW_MASK_BITS) & SearchNodeGraph.LOW_MASK) >>> 0,
            level: Number(meta & 0xFFn)
        };
    }

    private static metaFromParts(maskLo: number, maskHi: number, level: number): bigint {
        const bitset = (BigInt(maskHi) << SearchNodeGraph.LOW_MASK_BITS) | BigInt(maskLo);
        return (bitset << SearchNodeGraph.ENCHANT_SHIFT) | BigInt(level);
    }

    private ensureEdgeCapacity(required: number): void {
        if (required <= this.edgeChildIds.length) return;

        let nextCapacity = this.edgeChildIds.length;
        while (nextCapacity < required) nextCapacity *= 2;

        const nextChildIds = new Uint32Array(nextCapacity);
        nextChildIds.set(this.edgeChildIds);
        this.edgeChildIds = nextChildIds;

        const nextWeights = new Int32Array(nextCapacity);
        nextWeights.set(this.edgeWeights);
        this.edgeWeights = nextWeights;
    }

    private assertNode(nodeId: number): void {
        if (nodeId < 0 || nodeId >= this.combos.length) {
            throw new Error(`Unknown search node ID ${nodeId}`);
        }
    }
}
