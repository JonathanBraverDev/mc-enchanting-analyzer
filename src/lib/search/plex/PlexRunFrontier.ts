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

class PlexFrontierPositionIndex {
    private static readonly INITIAL_CAPACITY = 512;
    private static readonly MAX_LOAD_FACTOR = 0.65;

    private keys: Float64Array;
    private values: Int32Array;
    private states: Uint8Array;
    private mask: number;
    private resizeAt: number;
    private occupied = 0;
    private used = 0;

    public constructor(capacity: number = PlexFrontierPositionIndex.INITIAL_CAPACITY) {
        const size = PlexFrontierPositionIndex.nextPowerOfTwo(capacity);
        this.keys = new Float64Array(size);
        this.values = new Int32Array(size);
        this.values.fill(-1);
        this.states = new Uint8Array(size);
        this.mask = size - 1;
        this.resizeAt = Math.floor(size * PlexFrontierPositionIndex.MAX_LOAD_FACTOR);
    }

    public get(key: number): number | undefined {
        let index = this.hash(key) & this.mask;
        while (this.states[index] !== 0) {
            if (this.states[index] === 1 && this.keys[index] === key) {
                const value = this.values[index]!;
                return value === -1 ? undefined : value;
            }
            index = (index + 1) & this.mask;
        }
        return undefined;
    }

    public set(key: number, value: number): void {
        if (this.used >= this.resizeAt) this.grow();
        this.insert(key, value);
    }

    public delete(key: number): void {
        let index = this.hash(key) & this.mask;
        while (this.states[index] !== 0) {
            if (this.states[index] === 1 && this.keys[index] === key) {
                this.states[index] = 2;
                this.values[index] = -1;
                this.occupied--;
                return;
            }
            index = (index + 1) & this.mask;
        }
    }

    private insert(key: number, value: number): void {
        let index = this.hash(key) & this.mask;
        let firstDeleted = -1;

        while (this.states[index] !== 0) {
            if (this.states[index] === 1 && this.keys[index] === key) {
                this.values[index] = value;
                return;
            }
            if (firstDeleted === -1 && this.states[index] === 2) firstDeleted = index;
            index = (index + 1) & this.mask;
        }

        const target = firstDeleted === -1 ? index : firstDeleted;
        if (this.states[target] === 0) this.used++;
        this.states[target] = 1;
        this.keys[target] = key;
        this.values[target] = value;
        this.occupied++;
    }

    private grow(): void {
        const oldKeys = this.keys;
        const oldValues = this.values;
        const oldStates = this.states;
        const nextSize = this.occupied >= this.resizeAt ? oldKeys.length * 2 : oldKeys.length;

        this.keys = new Float64Array(nextSize);
        this.values = new Int32Array(nextSize);
        this.values.fill(-1);
        this.states = new Uint8Array(nextSize);
        this.mask = nextSize - 1;
        this.resizeAt = Math.floor(nextSize * PlexFrontierPositionIndex.MAX_LOAD_FACTOR);
        this.occupied = 0;
        this.used = 0;

        for (let i = 0; i < oldKeys.length; i++) {
            if (oldStates[i] === 1) this.insert(oldKeys[i]!, oldValues[i]!);
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
    private readonly positionsByState = new PlexFrontierPositionIndex();

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
