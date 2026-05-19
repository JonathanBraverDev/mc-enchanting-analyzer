import type { PlexNodeId } from '#lib/search/plex/PlexGraph.js';
import {
    getPlexPayloadKey,
    type PlexPayload,
    type PlexPayloadKey
} from '#lib/search/plex/PlexPayload.js';

export interface PlexFrontierPopTarget {
    graphId: number;
    nodeId: PlexNodeId;
    mass: bigint;
    payload: PlexPayload;
}

interface PlexFrontierEntry extends PlexFrontierPopTarget {
    readonly key: PlexPayloadKey;
}

/** Max-heap frontier for pending Plex work, merging identical structural + payload states. */
export class PlexRunFrontier {
    private readonly heap: PlexFrontierEntry[] = [];
    private readonly positionsByKey = new Map<PlexPayloadKey, number>();

    public get size(): number {
        return this.heap.length;
    }

    public pushOrMerge(graphId: number, nodeId: PlexNodeId, mass: bigint, payload: PlexPayload): void {
        const key = this.getPendingKey(graphId, nodeId, payload);
        const existingIndex = this.positionsByKey.get(key);
        if (existingIndex !== undefined) {
            const existing = this.heap[existingIndex]!;
            existing.mass += mass;
            this.bubbleUp(existingIndex);
            return;
        }

        const index = this.heap.length;
        this.heap.push({ graphId, nodeId, mass, payload, key });
        this.positionsByKey.set(key, index);
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
        this.positionsByKey.delete(root.key);

        const last = this.heap.pop();
        if (this.heap.length > 0 && last) {
            this.heap[0] = last;
            this.positionsByKey.set(last.key, 0);
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
        this.positionsByKey.set(entry.key, current);
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
        this.positionsByKey.set(entry.key, current);
    }

    private moveHeapEntry(from: number, to: number): void {
        const entry = this.heap[from]!;
        this.heap[to] = entry;
        this.positionsByKey.set(entry.key, to);
    }

    private getPendingKey(graphId: number, nodeId: PlexNodeId, payload: PlexPayload): PlexPayloadKey {
        return `${graphId}:${nodeId}:${getPlexPayloadKey(payload)}`;
    }
}
