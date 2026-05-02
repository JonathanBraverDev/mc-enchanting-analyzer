import { POOL_CONSTANTS } from '#constants/engine.js';

/**
 * Max-probability frontier keyed by dense SearchNodeGraph node IDs.
 * Uses direct nodeId -> heap index mapping instead of hashing node metadata.
 */
export class NodeIdSearchFrontier {
    private heap: Uint32Array;
    private probs: BigUint64Array;
    private positions: Int32Array;
    private _size = 0;

    constructor(initialCapacity: number = POOL_CONSTANTS.INITIAL_HEAP_CAPACITY) {
        this.heap = new Uint32Array(initialCapacity);
        this.probs = new BigUint64Array(initialCapacity);
        this.positions = new Int32Array(initialCapacity).fill(-1);
    }

    public pushOrMerge(nodeId: number, prob: bigint): void {
        this.ensureNodeCapacity(nodeId);

        const existingIdx = this.positions[nodeId]!;
        if (existingIdx !== -1) {
            this.probs[nodeId]! += prob;
            this.bubbleUp(existingIdx);
            return;
        }

        this.ensureHeapCapacity(this._size + 1);
        const heapIdx = this._size++;
        this.heap[heapIdx] = nodeId;
        this.probs[nodeId] = prob;
        this.positions[nodeId] = heapIdx;
        this.bubbleUp(heapIdx);
    }

    public popFast(out: { nodeId: number; prob: bigint }): boolean {
        if (this._size === 0) return false;

        const nodeId = this.heap[0]!;
        out.nodeId = nodeId;
        out.prob = this.probs[nodeId]!;
        this.probs[nodeId] = 0n;
        this.positions[nodeId] = -1;

        const lastNodeId = this.heap[--this._size]!;
        if (this._size > 0) {
            this.heap[0] = lastNodeId;
            this.positions[lastNodeId] = 0;
            this.sinkDown(0);
        }

        return true;
    }

    public peekProb(): bigint {
        return this._size > 0 ? this.probs[this.heap[0]!]! : 0n;
    }

    public size(): number {
        return this._size;
    }

    public get indexMapSize(): number {
        return this._size;
    }

    public forEachNode(callback: (nodeId: number, prob: bigint) => void): void {
        for (let i = 0; i < this._size; i++) {
            const nodeId = this.heap[i]!;
            callback(nodeId, this.probs[nodeId]!);
        }
    }

    public clone(): NodeIdSearchFrontier {
        const other = new NodeIdSearchFrontier(this.heap.length);
        this.copyTo(other);
        return other;
    }

    public copyTo(other: NodeIdSearchFrontier): void {
        other.heap = new Uint32Array(this.heap.length);
        other.heap.set(this.heap);
        other.probs = new BigUint64Array(this.probs.length);
        other.probs.set(this.probs);
        other.positions = new Int32Array(this.positions.length);
        other.positions.set(this.positions);
        other._size = this._size;
    }

    private ensureHeapCapacity(required: number): void {
        if (required <= this.heap.length) return;

        let nextCapacity = this.heap.length;
        while (nextCapacity < required) nextCapacity *= 2;

        const nextHeap = new Uint32Array(nextCapacity);
        nextHeap.set(this.heap);
        this.heap = nextHeap;
    }

    private ensureNodeCapacity(nodeId: number): void {
        if (nodeId < this.probs.length) return;

        let nextCapacity = this.probs.length;
        while (nextCapacity <= nodeId) nextCapacity *= 2;

        const nextProbs = new BigUint64Array(nextCapacity);
        nextProbs.set(this.probs);
        this.probs = nextProbs;

        const nextPositions = new Int32Array(nextCapacity).fill(-1);
        nextPositions.set(this.positions);
        this.positions = nextPositions;
    }

    private bubbleUp(idx: number): void {
        const nodeId = this.heap[idx]!;
        const prob = this.probs[nodeId]!;

        while (idx > 0) {
            const parentIdx = (idx - 1) >>> 2;
            const parentNodeId = this.heap[parentIdx]!;
            if (prob <= this.probs[parentNodeId]!) break;

            this.heap[idx] = parentNodeId;
            this.positions[parentNodeId] = idx;
            idx = parentIdx;
        }

        this.heap[idx] = nodeId;
        this.positions[nodeId] = idx;
    }

    private sinkDown(idx: number): void {
        const nodeId = this.heap[idx]!;
        const prob = this.probs[nodeId]!;

        while (true) {
            let swapIdx = -1;
            let maxProb = prob;

            const firstChildIdx = (idx << 2) + 1;
            const lastChildIdx = firstChildIdx + 4;

            for (let i = firstChildIdx; i < lastChildIdx && i < this._size; i++) {
                const childNodeId = this.heap[i]!;
                const childProb = this.probs[childNodeId]!;
                if (childProb > maxProb) {
                    maxProb = childProb;
                    swapIdx = i;
                }
            }

            if (swapIdx === -1) break;

            const swapNodeId = this.heap[swapIdx]!;
            this.heap[idx] = swapNodeId;
            this.positions[swapNodeId] = idx;
            idx = swapIdx;
        }

        this.heap[idx] = nodeId;
        this.positions[nodeId] = idx;
    }
}
