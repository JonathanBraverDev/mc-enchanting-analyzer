import type { PlexNodeId, PlexEdge } from '#lib/search/plex/PlexGraph.js';
import { PlexRunFrontier, type PlexFrontierPopTarget } from '#lib/search/plex/PlexRunFrontier.js';
import { type PlexPayload, type PlexPayloadId } from '#lib/search/plex/PlexPayload.js';
import { PlexPayloadStore } from '#lib/search/plex/PlexPayloadStore.js';

export type PlexWorkItem = PlexFrontierPopTarget;

export interface PlexResidueStats {
    readonly count: number;
    readonly mass: bigint;
}

/**
 * Owns Plex pending-work logistics that are orthogonal to search semantics.
 *
 * PlexRun should decide what an expansion means. This store handles the yuck:
 * frontier merge identity, heap ordering, payload append identity, and carried
 * split residues keyed to the same graph/node/payload state as pending work.
 */
export class PlexWorkStore {
    private readonly frontier = new PlexRunFrontier();
    private readonly forwardingResidues: Array<Map<number, Map<PlexPayloadId, BigUint64Array>> | undefined> = [];

    public constructor(private readonly payloads: PlexPayloadStore = new PlexPayloadStore()) {}

    public get size(): number {
        return this.frontier.size;
    }

    public peekMass(): bigint {
        return this.frontier.peekMass();
    }

    public push(graphId: number, nodeId: PlexNodeId, mass: bigint, payload: PlexPayload): void {
        if (mass === 0n) return;
        this.frontier.pushOrMerge(graphId, nodeId, mass, payload);
    }

    public popLargest(out: PlexWorkItem): boolean {
        return this.frontier.pop(out);
    }

    public forEachPending(callback: (entry: PlexWorkItem) => void): void {
        this.frontier.forEach(callback);
    }

    public appendPayloadEdge(payload: PlexPayload, edge: Pick<PlexEdge, 'choice'>): PlexPayload {
        return this.payloads.appendEdge(payload, edge);
    }

    public getForwardingResidues(work: PlexWorkItem): BigUint64Array | undefined {
        return this.forwardingResidues[work.graphId]?.get(work.nodeId)?.get(work.payload.id);
    }

    public setForwardingResidues(work: PlexWorkItem, residues: BigUint64Array | undefined): void {
        let graphResidues = this.forwardingResidues[work.graphId];
        if (!graphResidues) {
            if (!residues) return;
            graphResidues = new Map<number, Map<PlexPayloadId, BigUint64Array>>();
            this.forwardingResidues[work.graphId] = graphResidues;
        }

        let nodeResidues = graphResidues.get(work.nodeId);
        if (!nodeResidues) {
            if (!residues) return;
            nodeResidues = new Map<PlexPayloadId, BigUint64Array>();
            graphResidues.set(work.nodeId, nodeResidues);
        }

        if (residues) {
            nodeResidues.set(work.payload.id, residues);
        } else {
            nodeResidues.delete(work.payload.id);
            if (nodeResidues.size === 0) graphResidues.delete(work.nodeId);
        }
    }

    public getActiveResidueStats(getTotalWeight: (graphId: number, nodeId: PlexNodeId) => number): PlexResidueStats {
        let count = 0;
        let mass = 0n;
        for (let graphId = 0; graphId < this.forwardingResidues.length; graphId++) {
            const graphResidues = this.forwardingResidues[graphId];
            if (!graphResidues) continue;
            for (const [nodeId, nodeResidues] of graphResidues) {
                let residueNumerator = 0n;
                for (const residues of nodeResidues.values()) {
                    for (const residue of residues) {
                        if (residue === 0n) continue;
                        count++;
                        residueNumerator += residue;
                    }
                }
                if (residueNumerator === 0n) continue;
                mass += residueNumerator / BigInt(getTotalWeight(graphId, nodeId as PlexNodeId));
            }
        }
        return { count, mass };
    }
}
