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

/** Max-heap frontier for pending Plex work, merging identical structural + payload states. */
export class PlexRunFrontier {
    private readonly heap: PlexFrontierEntry[] = [];
    private readonly positionsByState = new Map<number, Map<PlexPayloadId, number>>();

    public get size(): number {
        return this.heap.length;
    }

    public pushOrMerge(graphId: number, nodeId: PlexNodeId, mass: bigint, payload: PlexPayload): void {
        const stateId = this.getStateId(graphId, nodeId);
        const existingIndex = this.positionsByState.get(stateId)?.get(payload.id);
        if (existingIndex !== undefined) {
            const existing = this.heap[existingIndex]!;
            existing.mass += mass;
            this.bubbleUp(existingIndex);
            return;
        }

        const index = this.heap.length;
        this.heap.push({ graphId, nodeId, mass, payload, payloadId: payload.id });
        this.setPosition(stateId, payload.id, index);
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
        this.deletePosition(this.getStateId(root.graphId, root.nodeId), root.payloadId);

        const last = this.heap.pop();
        if (this.heap.length > 0 && last) {
            this.heap[0] = last;
            this.setPosition(this.getStateId(last.graphId, last.nodeId), last.payloadId, 0);
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
        this.setPosition(this.getStateId(entry.graphId, entry.nodeId), entry.payloadId, current);
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
        this.setPosition(this.getStateId(entry.graphId, entry.nodeId), entry.payloadId, current);
    }

    private moveHeapEntry(from: number, to: number): void {
        const entry = this.heap[from]!;
        this.heap[to] = entry;
        this.setPosition(this.getStateId(entry.graphId, entry.nodeId), entry.payloadId, to);
    }

    private setPosition(stateId: number, payloadId: PlexPayloadId, index: number): void {
        let positions = this.positionsByState.get(stateId);
        if (!positions) {
            positions = new Map<PlexPayloadId, number>();
            this.positionsByState.set(stateId, positions);
        }
        positions.set(payloadId, index);
    }

    private deletePosition(stateId: number, payloadId: PlexPayloadId): void {
        const positions = this.positionsByState.get(stateId);
        if (!positions) return;
        positions.delete(payloadId);
        if (positions.size === 0) this.positionsByState.delete(stateId);
    }

    private getStateId(graphId: number, nodeId: PlexNodeId): number {
        return pairIntegers(graphId, nodeId);
    }
}

function pairIntegers(left: number, right: number): number {
    const sum = left + right;
    return ((sum * (sum + 1)) / 2) + right;
}
