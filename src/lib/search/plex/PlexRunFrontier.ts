import type { PlexNodeId } from '#lib/search/plex/PlexGraph.js';
import {
    type PlexPayload,
    type PlexPayloadId
} from '#lib/search/plex/PlexPayload.js';

export interface PlexFrontierPopTarget {
    graphId: number;
    nodeId: PlexNodeId;
    mass: bigint;
    payload: PlexPayload;
}

interface PlexFrontierEntry extends PlexFrontierPopTarget {
    readonly payloadId: PlexPayloadId;
}

/**
 * Max-heap frontier for pending Plex work.
 *
 * PlexGraph edges aggregate alternatives that reach the same future exclusion
 * state, so the payload expression is expected to be functionally determined by
 * `(graphId, nodeId)`. Keep that as a checked invariant rather than paying for a
 * nested payload index on every heap move.
 */
export class PlexRunFrontier {
    private readonly heap: PlexFrontierEntry[] = [];
    private readonly positionsByState = new Map<number, number>();

    public get size(): number {
        return this.heap.length;
    }

    public pushOrMerge(graphId: number, nodeId: PlexNodeId, mass: bigint, payload: PlexPayload): void {
        const stateId = this.getStateId(graphId, nodeId);
        const existingIndex = this.positionsByState.get(stateId);
        if (existingIndex !== undefined) {
            const existing = this.heap[existingIndex]!;
            if (existing.payloadId !== payload.id) {
                throw new Error(
                    `Plex frontier state ${graphId}:${String(nodeId)} received payload ${String(payload.id)} after payload ${String(existing.payloadId)}.`
                );
            }
            existing.mass += mass;
            this.bubbleUp(existingIndex);
            return;
        }

        const index = this.heap.length;
        this.heap.push({ graphId, nodeId, mass, payload, payloadId: payload.id });
        this.setPosition(stateId, index);
        this.bubbleUp(index);
    }

    public peekMass(): bigint {
        return this.heap[0]?.mass ?? 0n;
    }

    public forEach(callback: (entry: PlexFrontierPopTarget) => void): void {
        for (const entry of this.heap) callback(entry);
    }

    public pop(out: PlexFrontierPopTarget): boolean {
        const root = this.heap[0];
        if (!root) return false;

        out.graphId = root.graphId;
        out.nodeId = root.nodeId;
        out.mass = root.mass;
        out.payload = root.payload;
        this.deletePosition(this.getStateId(root.graphId, root.nodeId));

        const last = this.heap.pop();
        if (this.heap.length > 0 && last) {
            this.heap[0] = last;
            this.setPosition(this.getStateId(last.graphId, last.nodeId), 0);
            this.sinkDown(0);
        }

        return true;
    }

    private bubbleUp(index: number): void {
        let current = index;
        const entry = this.heap[current]!;

        while (current > 0) {
            const parent = (current - 1) >>> 1;
            if (this.heap[parent]!.mass >= entry.mass) break;
            this.moveHeapEntry(parent, current);
            current = parent;
        }

        this.heap[current] = entry;
        this.setPosition(this.getStateId(entry.graphId, entry.nodeId), current);
    }

    private sinkDown(index: number): void {
        let current = index;
        const entry = this.heap[current]!;

        while (true) {
            const left = (current << 1) + 1;
            if (left >= this.heap.length) break;
            const right = left + 1;
            let child = left;
            if (right < this.heap.length && this.heap[right]!.mass > this.heap[left]!.mass) {
                child = right;
            }
            if (entry.mass >= this.heap[child]!.mass) break;
            this.moveHeapEntry(child, current);
            current = child;
        }

        this.heap[current] = entry;
        this.setPosition(this.getStateId(entry.graphId, entry.nodeId), current);
    }

    private moveHeapEntry(from: number, to: number): void {
        const entry = this.heap[from]!;
        this.heap[to] = entry;
        this.setPosition(this.getStateId(entry.graphId, entry.nodeId), to);
    }

    private setPosition(stateId: number, index: number): void {
        this.positionsByState.set(stateId, index);
    }

    private deletePosition(stateId: number): void {
        this.positionsByState.delete(stateId);
    }

    private getStateId(graphId: number, nodeId: PlexNodeId): number {
        return pairIntegers(graphId, nodeId);
    }
}

function pairIntegers(left: number, right: number): number {
    const sum = left + right;
    return ((sum * (sum + 1)) / 2) + right;
}
