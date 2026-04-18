import { POOL_CONSTANTS, BIGINT_CONSTANTS } from '#constants/engine.js';

/**
 * A specialized, TypedArray-backed priority queue for PackedNode data.
 * Designed for maximum performance in the search hot path by eliminating object allocations
 * and generic function overhead.
 */
export class SearchHeap {
    private probBuffer: BigUint64Array;
    private metaBuffer: BigUint64Array; // (bitset << 8 | level)
    private comboBuffer: Float64Array;
    
    private heap: Uint32Array; // Stores dataId (index into buffers)
    private indexMap: Map<bigint, number>; // meta -> index in 'heap' array
    
    private _size: number = 0;
    private _nextId: number = 0;
    private capacity: number;
    
    private freeIds: Uint32Array;
    private freeCount: number = 0;

    constructor(initialCapacity: number = POOL_CONSTANTS.INITIAL_HEAP_CAPACITY) {
        this.capacity = initialCapacity;
        this.probBuffer = new BigUint64Array(initialCapacity);
        this.metaBuffer = new BigUint64Array(initialCapacity);
        this.comboBuffer = new Float64Array(initialCapacity);
        
        this.heap = new Uint32Array(initialCapacity);
        this.indexMap = new Map();
        
        this.freeIds = new Uint32Array(initialCapacity);
    }

    /**
     * Pops the next available dataId from the free list.
     */
    private nextFreeId(): number {
        return this.freeIds[--this.freeCount]!;
    }

    public pushOrMerge(meta: bigint, prob: bigint, _level: number, combo: number): void {
        const existingIdx = this.indexMap.get(meta);
        if (existingIdx !== undefined) {
            const dataId = this.heap[existingIdx]!;
            this.probBuffer[dataId]! += prob;
            this.bubbleUp(existingIdx);
            return;
        }

        if (this._nextId >= this.capacity && this.freeCount === 0) {
            this.grow();
        }

        const dataId = this.freeCount > 0 ? this.nextFreeId() : this._nextId++;
        this.probBuffer[dataId] = prob;
        this.metaBuffer[dataId] = meta;
        this.comboBuffer[dataId] = combo;

        const heapIdx = this._size++;
        this.heap[heapIdx] = dataId;
        this.indexMap.set(meta, heapIdx);
        this.bubbleUp(heapIdx);
    }

    public pop(): { meta: bigint, prob: bigint, level: number, combo: number } | undefined {
        if (this._size === 0) return undefined;

        const dataId = this.heap[0]!;
        const meta = this.metaBuffer[dataId]!;
        const level = Number(meta & BIGINT_CONSTANTS.RANK_MASK);
        const prob = this.probBuffer[dataId]!;
        const combo = this.comboBuffer[dataId]!;

        this.indexMap.delete(meta);
        this.freeIds[this.freeCount++] = dataId;

        const lastDataId = this.heap[--this._size]!;
        if (this._size > 0) {
            this.heap[0] = lastDataId;
            this.indexMap.set(this.metaBuffer[lastDataId]!, 0);
            this.sinkDown(0);
        }

        return { meta, prob, level, combo };
    }

    /**
     * Specialized pop for minimal-allocation search loops.
     */
    public popFast(out: { meta: bigint, prob: bigint, level: number, combo: number }): boolean {
        if (this._size === 0) return false;

        const dataId = this.heap[0]!;
        const meta = this.metaBuffer[dataId]!;
        
        out.meta = meta;
        out.prob = this.probBuffer[dataId]!;
        out.level = Number(meta & BIGINT_CONSTANTS.RANK_MASK);
        out.combo = this.comboBuffer[dataId]!;

        this.indexMap.delete(meta);
        this.freeIds[this.freeCount++] = dataId;

        const lastDataId = this.heap[--this._size]!;
        if (this._size > 0) {
            this.heap[0] = lastDataId;
            this.indexMap.set(this.metaBuffer[lastDataId]!, 0);
            this.sinkDown(0);
        }

        return true;
    }

    public peekProb(): bigint {
        return this._size > 0 ? this.probBuffer[this.heap[0]!]! : 0n;
    }

    public size(): number {
        return this._size;
    }

    public get indexMapSize(): number {
        return this.indexMap.size;
    }

    private bubbleUp(idx: number): void {
        const dataId = this.heap[idx]!;
        const prob = this.probBuffer[dataId]!;
        const meta = this.metaBuffer[dataId]!;
        
        while (idx > 0) {
            const parentIdx = (idx - 1) >>> 1;
            const parentDataId = this.heap[parentIdx]!;
            if (prob <= this.probBuffer[parentDataId]!) break;

            this.heap[idx] = parentDataId;
            this.indexMap.set(this.metaBuffer[parentDataId]!, idx);
            idx = parentIdx;
        }

        this.heap[idx] = dataId;
        this.indexMap.set(meta, idx);
    }

    private sinkDown(idx: number): void {
        const dataId = this.heap[idx]!;
        const prob = this.probBuffer[dataId]!;
        const meta = this.metaBuffer[dataId]!;

        while (true) {
            let leftChildIdx = (idx << 1) + 1;
            let rightChildIdx = (idx << 1) + 2;
            let swapIdx = -1;
            let maxProb = prob;

            if (leftChildIdx < this._size) {
                const childDataId = this.heap[leftChildIdx]!;
                const childProb = this.probBuffer[childDataId]!;
                if (childProb > maxProb) {
                    maxProb = childProb;
                    swapIdx = leftChildIdx;
                }
            }

            if (rightChildIdx < this._size) {
                const childDataId = this.heap[rightChildIdx]!;
                const childProb = this.probBuffer[childDataId]!;
                if (childProb > maxProb) {
                    swapIdx = rightChildIdx;
                }
            }

            if (swapIdx === -1) break;

            const swapDataId = this.heap[swapIdx]!;
            this.heap[idx] = swapDataId;
            this.indexMap.set(this.metaBuffer[swapDataId]!, idx);

            idx = swapIdx;
        }

        this.heap[idx] = dataId;
        this.indexMap.set(meta, idx);
    }

    private grow(): void {
        const newCapacity = this.capacity * 2;
        
        const newProb = new BigUint64Array(newCapacity);
        newProb.set(this.probBuffer);
        this.probBuffer = newProb;

        const newMeta = new BigUint64Array(newCapacity);
        newMeta.set(this.metaBuffer);
        this.metaBuffer = newMeta;

        const newCombo = new Float64Array(newCapacity);
        newCombo.set(this.comboBuffer);
        this.comboBuffer = newCombo;

        const newHeap = new Uint32Array(newCapacity);
        newHeap.set(this.heap);
        this.heap = newHeap;

        const newFree = new Uint32Array(newCapacity);
        newFree.set(this.freeIds);
        this.freeIds = newFree;

        this.capacity = newCapacity;
    }

    /**
     * Required for cache serialization/cloning.
     */
    public clone(): SearchHeap {
        const other = new SearchHeap(this.capacity);
        other.probBuffer.set(this.probBuffer);
        other.metaBuffer.set(this.metaBuffer);
        other.comboBuffer.set(this.comboBuffer);
        other.heap.set(this.heap);
        other.freeIds.set(this.freeIds);
        other.freeCount = this.freeCount;
        other._size = this._size;
        other._nextId = this._nextId;
        other.indexMap = new Map(this.indexMap);
        return other;
    }
}
