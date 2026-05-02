import { ExpansionBlueprint, PackedCombo } from '#types/index.js';

interface ForwardingResidue {
    residue: bigint;
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

    private readonly numericKeyToId = new Map<number, number>();
    private readonly bigintMetaToId = new Map<bigint, number>();
    private metas: Array<bigint | undefined> = [];
    private maskLos: number[] = [];
    private maskHis: number[] = [];
    private levels: number[] = [];
    private combos: PackedCombo[] = [];
    private counts: number[] = [];
    private blueprints: Array<ExpansionBlueprint | undefined> = [];
    private residues: Array<ForwardingResidue | undefined> = [];

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
        const normalizedMaskLo = maskLo >>> 0;
        const normalizedMaskHi = maskHi >>> 0;
        const numericKey = SearchNodeGraph.numericKey(normalizedMaskLo, normalizedMaskHi, level);

        if (numericKey > Number.MAX_SAFE_INTEGER) {
            return this.getOrCreateNode(SearchNodeGraph.metaFromParts(normalizedMaskLo, normalizedMaskHi, level), combo, count);
        }

        const existing = this.numericKeyToId.get(numericKey);
        if (existing !== undefined) return existing;

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
        for (const [meta, nodeId] of this.numericKeyToId) {
            graph.numericKeyToId.set(meta, nodeId);
        }
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

    private assertNode(nodeId: number): void {
        if (nodeId < 0 || nodeId >= this.combos.length) {
            throw new Error(`Unknown search node ID ${nodeId}`);
        }
    }
}
