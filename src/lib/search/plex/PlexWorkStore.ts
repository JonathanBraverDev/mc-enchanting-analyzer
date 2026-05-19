import type { PlexNodeId, PlexEdge } from '#lib/search/plex/PlexGraph.js';
import { PlexRunFrontier, type PlexFrontierIdentityMode, type PlexFrontierPopTarget } from '#lib/search/plex/PlexRunFrontier.js';
import { type PlexPayload, type PlexPayloadId } from '#lib/search/plex/PlexPayload.js';
import { PlexPayloadStore } from '#lib/search/plex/PlexPayloadStore.js';

export type PlexWorkItem = PlexFrontierPopTarget;

export interface PlexWorkStoreOptions {
    readonly frontierIdentityMode?: PlexFrontierIdentityMode | undefined;
}

export interface PlexResidueStats {
    readonly count: number;
    readonly mass: bigint;
}

interface PlexResidueState {
    readonly graphId: number;
    readonly nodeId: PlexNodeId;
    readonly payloads: Map<PlexPayloadId, BigUint64Array>;
}

/**
 * Owns Plex pending-work logistics that are orthogonal to search semantics.
 *
 * PlexRun should decide what an expansion means. This store handles the yuck:
 * frontier merge identity, heap ordering, payload append identity, and carried
 * split residues keyed to the same graph/node/payload state as pending work.
 */
export class PlexWorkStore {
    private readonly frontier: PlexRunFrontier;
    private readonly forwardingResidues = new Map<number, PlexResidueState>();

    public constructor(
        private readonly payloads: PlexPayloadStore = new PlexPayloadStore(),
        options: PlexWorkStoreOptions = {}
    ) {
        this.frontier = new PlexRunFrontier({ identityMode: options.frontierIdentityMode });
    }

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
        return this.forwardingResidues.get(this.getResidueStateId(work))?.payloads.get(work.payload.id);
    }

    public setForwardingResidues(work: PlexWorkItem, residues: BigUint64Array | undefined): void {
        const stateId = this.getResidueStateId(work);
        let state = this.forwardingResidues.get(stateId);
        if (!state) {
            if (!residues) return;
            state = {
                graphId: work.graphId,
                nodeId: work.nodeId,
                payloads: new Map<PlexPayloadId, BigUint64Array>()
            };
            this.forwardingResidues.set(stateId, state);
        }

        if (residues) {
            state.payloads.set(work.payload.id, residues);
        } else {
            state.payloads.delete(work.payload.id);
            if (state.payloads.size === 0) this.forwardingResidues.delete(stateId);
        }
    }

    public getActiveResidueStats(getTotalWeight: (graphId: number, nodeId: PlexNodeId) => number): PlexResidueStats {
        let count = 0;
        let mass = 0n;
        for (const state of this.forwardingResidues.values()) {
            let residueNumerator = 0n;
            for (const residues of state.payloads.values()) {
                for (const residue of residues) {
                    if (residue === 0n) continue;
                    count++;
                    residueNumerator += residue;
                }
            }
            if (residueNumerator === 0n) continue;
            mass += residueNumerator / BigInt(getTotalWeight(state.graphId, state.nodeId));
        }
        return { count, mass };
    }

    private getResidueStateId(work: PlexWorkItem): number {
        return pairIntegers(work.graphId, work.nodeId);
    }
}

function pairIntegers(left: number, right: number): number {
    const sum = left + right;
    return ((sum * (sum + 1)) / 2) + right;
}
