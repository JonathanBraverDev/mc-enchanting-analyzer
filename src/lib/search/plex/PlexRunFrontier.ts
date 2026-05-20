import type { PlexNodeId } from '#lib/search/plex/PlexGraph.js';
import {
    type PlexPayload,
    type PlexPayloadId
} from '#lib/search/plex/PlexPayload.js';
import { PLEX_HASH_CONSTANTS, PLEX_INDEX_LIMITS, PLEX_INDEX_SENTINELS } from '#lib/search/plex/PlexConstants.js';

export type PlexFrontierIdentityMode = 'reduced' | 'payload';

export interface PlexRunFrontierOptions {
    /**
     * Reduced mode merges by `(graphId, nodeId)` and requires payload identity to be
     * implied by that structural state. Payload mode is the conservative fallback:
     * it merges by `(graphId, nodeId, payloadId)` when a registry breaks that invariant.
     */
    readonly identityMode?: PlexFrontierIdentityMode | undefined;
}

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
    private keys: Float64Array;
    private values: Int32Array;
    private states: Uint8Array;
    private mask: number;
    private resizeAt: number;
    private occupied = 0;
    private used = 0;

    public constructor(capacity: number = PLEX_INDEX_LIMITS.FRONTIER_INITIAL_CAPACITY) {
        const size = PlexFrontierPositionIndex.nextPowerOfTwo(capacity);
        this.keys = new Float64Array(size);
        this.values = new Int32Array(size);
        this.values.fill(PLEX_INDEX_SENTINELS.MISSING_VALUE);
        this.states = new Uint8Array(size);
        this.mask = size - 1;
        this.resizeAt = Math.floor(size * PLEX_INDEX_LIMITS.FRONTIER_MAX_LOAD_FACTOR);
    }

    public get(key: number): number | undefined {
        let index = this.hash(key) & this.mask;
        while (this.states[index] !== PLEX_INDEX_SENTINELS.EMPTY_SLOT) {
            if (this.states[index] === PLEX_INDEX_SENTINELS.OCCUPIED_SLOT && this.keys[index] === key) {
                const value = this.values[index]!;
                return value === PLEX_INDEX_SENTINELS.MISSING_VALUE ? undefined : value;
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
        while (this.states[index] !== PLEX_INDEX_SENTINELS.EMPTY_SLOT) {
            if (this.states[index] === PLEX_INDEX_SENTINELS.OCCUPIED_SLOT && this.keys[index] === key) {
                this.states[index] = PLEX_INDEX_SENTINELS.DELETED_SLOT;
                this.values[index] = PLEX_INDEX_SENTINELS.MISSING_VALUE;
                this.occupied--;
                return;
            }
            index = (index + 1) & this.mask;
        }
    }

    private insert(key: number, value: number): void {
        let index = this.hash(key) & this.mask;
        let firstDeleted: number = PLEX_INDEX_SENTINELS.MISSING_VALUE;

        while (this.states[index] !== PLEX_INDEX_SENTINELS.EMPTY_SLOT) {
            if (this.states[index] === PLEX_INDEX_SENTINELS.OCCUPIED_SLOT && this.keys[index] === key) {
                this.values[index] = value;
                return;
            }
            if (firstDeleted === PLEX_INDEX_SENTINELS.MISSING_VALUE && this.states[index] === PLEX_INDEX_SENTINELS.DELETED_SLOT) firstDeleted = index;
            index = (index + 1) & this.mask;
        }

        const target = firstDeleted === PLEX_INDEX_SENTINELS.MISSING_VALUE ? index : firstDeleted;
        if (this.states[target] === PLEX_INDEX_SENTINELS.EMPTY_SLOT) this.used++;
        this.states[target] = PLEX_INDEX_SENTINELS.OCCUPIED_SLOT;
        this.keys[target] = key;
        this.values[target] = value;
        this.occupied++;
    }

    private grow(): void {
        const oldKeys = this.keys;
        const oldValues = this.values;
        const oldStates = this.states;
        const nextSize = this.occupied >= this.resizeAt
            ? oldKeys.length * PLEX_INDEX_LIMITS.GROWTH_FACTOR
            : oldKeys.length;

        this.keys = new Float64Array(nextSize);
        this.values = new Int32Array(nextSize);
        this.values.fill(PLEX_INDEX_SENTINELS.MISSING_VALUE);
        this.states = new Uint8Array(nextSize);
        this.mask = nextSize - 1;
        this.resizeAt = Math.floor(nextSize * PLEX_INDEX_LIMITS.FRONTIER_MAX_LOAD_FACTOR);
        this.occupied = 0;
        this.used = 0;

        for (let i = 0; i < oldKeys.length; i++) {
            if (oldStates[i] === PLEX_INDEX_SENTINELS.OCCUPIED_SLOT) this.insert(oldKeys[i]!, oldValues[i]!);
        }
    }

    private hash(key: number): number {
        const low = key >>> 0;
        const high = Math.floor(key / PLEX_HASH_CONSTANTS.U32_BASIS) >>> 0;
        let h = (low ^ Math.imul(high, PLEX_HASH_CONSTANTS.GOLDEN_RATIO_32)) >>> 0;
        h ^= h >>> PLEX_HASH_CONSTANTS.AVALANCHE_SHIFT_1;
        h = Math.imul(h, PLEX_HASH_CONSTANTS.AVALANCHE_MULTIPLIER_1) >>> 0;
        h ^= h >>> PLEX_HASH_CONSTANTS.AVALANCHE_SHIFT_2;
        h = Math.imul(h, PLEX_HASH_CONSTANTS.AVALANCHE_MULTIPLIER_2) >>> 0;
        return (h ^ (h >>> PLEX_HASH_CONSTANTS.AVALANCHE_SHIFT_1)) >>> 0;
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
 * The fast path merges by reduced structural state `(graphId, nodeId)` when a
 * registry satisfies the Plex reduced-key invariant. Conservative fallback mode
 * includes `payloadId` in the merge key so Plex can still run safely for mutated
 * registries that violate that optimization.
 */
export class PlexRunFrontier {
    private readonly heap: PlexFrontierEntry[] = [];
    private readonly positionsByState = new PlexFrontierPositionIndex();
    private readonly positionsByPayloadState = new Map<string, number>();
    private readonly identityMode: PlexFrontierIdentityMode;

    public constructor(options: PlexRunFrontierOptions = {}) {
        this.identityMode = options.identityMode ?? 'reduced';
    }

    public get size(): number {
        return this.heap.length;
    }

    public pushOrMerge(graphId: number, nodeId: PlexNodeId, mass: bigint, payload: PlexPayload): void {
        const positionKey = this.getPositionKey(graphId, nodeId, payload.id);
        const existingIndex = this.getPosition(positionKey);
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
        this.setPosition(positionKey, index);
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
        this.deletePosition(this.getEntryPositionKey(root));

        const last = this.heap.pop();
        if (this.heap.length > 0 && last) {
            this.heap[0] = last;
            this.setPosition(this.getEntryPositionKey(last), 0);
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
        this.setPosition(this.getEntryPositionKey(entry), current);
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
        this.setPosition(this.getEntryPositionKey(entry), current);
    }

    private moveHeapEntry(from: number, to: number): void {
        const entry = this.heap[from]!;
        this.heap[to] = entry;
        this.setPosition(this.getEntryPositionKey(entry), to);
    }

    private getPosition(key: number | string): number | undefined {
        return typeof key === 'number'
            ? this.positionsByState.get(key)
            : this.positionsByPayloadState.get(key);
    }

    private setPosition(key: number | string, index: number): void {
        if (typeof key === 'number') {
            this.positionsByState.set(key, index);
        } else {
            this.positionsByPayloadState.set(key, index);
        }
    }

    private deletePosition(key: number | string): void {
        if (typeof key === 'number') {
            this.positionsByState.delete(key);
        } else {
            this.positionsByPayloadState.delete(key);
        }
    }

    private getEntryPositionKey(entry: PlexFrontierEntry): number | string {
        return this.getPositionKey(entry.graphId, entry.nodeId, entry.payloadId);
    }

    private getPositionKey(graphId: number, nodeId: PlexNodeId, payloadId: PlexPayloadId): number | string {
        const stateId = this.getStateId(graphId, nodeId);
        return this.identityMode === 'reduced'
            ? stateId
            : `${stateId}:${String(payloadId)}`;
    }

    private getStateId(graphId: number, nodeId: PlexNodeId): number {
        return pairIntegers(graphId, nodeId);
    }
}

function pairIntegers(left: number, right: number): number {
    const sum = left + right;
    return ((sum * (sum + 1)) / 2) + right;
}
