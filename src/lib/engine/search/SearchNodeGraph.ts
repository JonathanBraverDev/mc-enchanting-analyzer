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

    private readonly numericMetaToId = new Map<number, number>();
    private readonly bigintMetaToId = new Map<bigint, number>();
    private metas: bigint[] = [];
    private combos: PackedCombo[] = [];
    private counts: number[] = [];
    private blueprints: Array<ExpansionBlueprint | undefined> = [];
    private residues: Array<ForwardingResidue | undefined> = [];

    public getOrCreateNode(meta: bigint, combo: PackedCombo, count: number): number {
        const existing = this.getNodeId(meta);
        if (existing !== undefined) return existing;

        const nodeId = this.metas.length;
        this.setNodeId(meta, nodeId);
        this.metas.push(meta);
        this.combos.push(combo);
        this.counts.push(count);
        this.blueprints.push(undefined);
        this.residues.push(undefined);
        return nodeId;
    }

    public getMeta(nodeId: number): bigint {
        const meta = this.metas[nodeId];
        if (meta === undefined) throw new Error(`Unknown search node ID ${nodeId}`);
        return meta;
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
        return this.metas.length;
    }

    public clone(): SearchNodeGraph {
        const graph = new SearchNodeGraph();
        graph.metas = [...this.metas];
        graph.combos = [...this.combos];
        graph.counts = [...this.counts];
        graph.blueprints = [...this.blueprints];
        graph.residues = this.residues.map(residue => residue ? { residue: residue.residue } : undefined);
        for (const [meta, nodeId] of this.numericMetaToId) {
            graph.numericMetaToId.set(meta, nodeId);
        }
        for (const [meta, nodeId] of this.bigintMetaToId) {
            graph.bigintMetaToId.set(meta, nodeId);
        }
        return graph;
    }

    private getNodeId(meta: bigint): number | undefined {
        return meta <= SearchNodeGraph.MAX_SAFE_META
            ? this.numericMetaToId.get(Number(meta))
            : this.bigintMetaToId.get(meta);
    }

    private setNodeId(meta: bigint, nodeId: number): void {
        if (meta <= SearchNodeGraph.MAX_SAFE_META) {
            this.numericMetaToId.set(Number(meta), nodeId);
        } else {
            this.bigintMetaToId.set(meta, nodeId);
        }
    }

    private assertNode(nodeId: number): void {
        if (nodeId < 0 || nodeId >= this.metas.length) {
            throw new Error(`Unknown search node ID ${nodeId}`);
        }
    }
}
