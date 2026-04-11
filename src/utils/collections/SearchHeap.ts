
/**
 * A specialized, TypedArray-backed priority queue for PackedNode data.
 * Designed for maximum performance in the search hot path by eliminating object allocations
 * and generic function overhead.
 */
export class SearchHeap {
    private probBuffer: BigUint64Array;
    private bitsetBuffer: BigUint64Array;
    private comboBuffer: Float64Array;
    private levelBuffer: Uint8Array;
    
    private heap: Uint32Array; // Stores dataId (index into buffers)
    private indexMap: Map<bigint, number>; // meta -> index in 'heap' array
    
    private _size: number = 0;
    private _nextId: number = 0;
    private capacity: number;
    
    private freeIds: Uint32Array;
    private freeCount: number = 0;

    constructor(initialCapacity: number = 131072) {
        this.capacity = initialCapacity;
        this.probBuffer = new BigUint64Array(initialCapacity);
        this.bitsetBuffer = new BigUint64Array(initialCapacity);
        this.comboBuffer = new Float64Array(initialCapacity);
        this.levelBuffer = new Uint8Array(initialCapacity);
        
        this.heap = new Uint32Array(initialCapacity);
        this.indexMap = new Map();
        
        this.freeIds = new Uint32Array(initialCapacity);
    }

    public pushOrMerge(meta: bigint, prob: bigint, level: number, combo: number): void {
        const existingIdx = this.indexMap.get(meta);
        if (existingIdx !== undefined) {
            const dataId = this.heap[existingIdx];
            this.probBuffer[dataId] += prob;
            this.bubbleUp(existingIdx);
            return;
        }

        if (this._nextId >= this.capacity && this.freeCount === 0) {
            this.grow();
        }

        const dataId = this.freeCount > 0 ? this.freeIds[--this.freeCount] : this._nextId++;
        this.probBuffer[dataId] = prob;
        this.bitsetBuffer[dataId] = meta >> 8n;
        this.levelBuffer[dataId] = level;
        this.comboBuffer[dataId] = combo;

        const heapIdx = this._size++;
        this.heap[heapIdx] = dataId;
        this.indexMap.set(meta, heapIdx);
        this.bubbleUp(heapIdx);
    }

    public pop(): { meta: bigint, prob: bigint, level: number, combo: number } | undefined {
        if (this._size === 0) return undefined;

        const dataId = this.heap[0];
        const bitset = this.bitsetBuffer[dataId];
        const level = this.levelBuffer[dataId];
        const meta = (bitset << 8n) | BigInt(level);
        const prob = this.probBuffer[dataId];
        const combo = this.comboBuffer[dataId];

        this.indexMap.delete(meta);
        this.freeIds[this.freeCount++] = dataId;

        const lastDataId = this.heap[--this._size];
        if (this._size > 0) {
            this.heap[0] = lastDataId;
            const lastBitset = this.bitsetBuffer[lastDataId];
            const lastLevel = this.levelBuffer[lastDataId];
            this.indexMap.set((lastBitset << 8n) | BigInt(lastLevel), 0);
            this.sinkDown(0);
        }

        return { meta, prob, level, combo };
    }

    /**
     * Specialized pop for minimal-allocation search loops.
     */
    public popFast(out: { meta: bigint, prob: bigint, level: number, combo: number }): boolean {
        if (this._size === 0) return false;

        const dataId = this.heap[0];
        const bitset = this.bitsetBuffer[dataId];
        const level = this.levelBuffer[dataId];
        const meta = (bitset << 8n) | BigInt(level);
        
        out.meta = meta;
        out.prob = this.probBuffer[dataId];
        out.level = level;
        out.combo = this.comboBuffer[dataId];

        this.indexMap.delete(meta);
        this.freeIds[this.freeCount++] = dataId;

        const lastDataId = this.heap[--this._size];
        if (this._size > 0) {
            this.heap[0] = lastDataId;
            const lastBitset = this.bitsetBuffer[lastDataId];
            const lastLevel = this.levelBuffer[lastDataId];
            this.indexMap.set((lastBitset << 8n) | BigInt(lastLevel), 0);
            this.sinkDown(0);
        }

        return true;
    }

    public peekProb(): bigint {
        return this._size > 0 ? this.probBuffer[this.heap[0]] : 0n;
    }

    public size(): number {
        return this._size;
    }

    public get indexMapSize(): number {
        return this.indexMap.size;
    }

    private bubbleUp(idx: number): void {
        const dataId = this.heap[idx];
        const prob = this.probBuffer[dataId];
        
        while (idx > 0) {
            const parentIdx = (idx - 1) >>> 1;
            const parentDataId = this.heap[parentIdx];
            if (prob <= this.probBuffer[parentDataId]) break;

            this.heap[idx] = parentDataId;
            const pBitset = this.bitsetBuffer[parentDataId];
            const pLevel = this.levelBuffer[parentDataId];
            this.indexMap.set((pBitset << 8n) | BigInt(pLevel), idx);
            
            idx = parentIdx;
        }

        this.heap[idx] = dataId;
        const bitset = this.bitsetBuffer[dataId];
        const level = this.levelBuffer[dataId];
        this.indexMap.set((bitset << 8n) | BigInt(level), idx);
    }

    private sinkDown(idx: number): void {
        const dataId = this.heap[idx];
        const prob = this.probBuffer[dataId];

        while (true) {
            let leftChildIdx = (idx << 1) + 1;
            let rightChildIdx = (idx << 1) + 2;
            let swapIdx = -1;
            let maxProb = prob;

            if (leftChildIdx < this._size) {
                const childDataId = this.heap[leftChildIdx];
                if (this.probBuffer[childDataId] > maxProb) {
                    maxProb = this.probBuffer[childDataId];
                    swapIdx = leftChildIdx;
                }
            }

            if (rightChildIdx < this._size) {
                const childDataId = this.heap[rightChildIdx];
                if (this.probBuffer[childDataId] > maxProb) {
                    swapIdx = rightChildIdx;
                }
            }

            if (swapIdx === -1) break;

            const swapDataId = this.heap[swapIdx];
            this.heap[idx] = swapDataId;
            const sBitset = this.bitsetBuffer[swapDataId];
            const sLevel = this.levelBuffer[swapDataId];
            this.indexMap.set((sBitset << 8n) | BigInt(sLevel), idx);

            idx = swapIdx;
        }

        this.heap[idx] = dataId;
        const bitset = this.bitsetBuffer[dataId];
        const level = this.levelBuffer[dataId];
        this.indexMap.set((bitset << 8n) | BigInt(level), idx);
    }

    private grow(): void {
        const newCapacity = this.capacity * 2;
        
        const newProb = new BigUint64Array(newCapacity);
        newProb.set(this.probBuffer);
        this.probBuffer = newProb;

        const newBitset = new BigUint64Array(newCapacity);
        newBitset.set(this.bitsetBuffer);
        this.bitsetBuffer = newBitset;

        const newCombo = new Float64Array(newCapacity);
        newCombo.set(this.comboBuffer);
        this.comboBuffer = newCombo;

        const newLevel = new Uint8Array(newCapacity);
        newLevel.set(this.levelBuffer);
        this.levelBuffer = newLevel;

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
        other.bitsetBuffer.set(this.bitsetBuffer);
        other.comboBuffer.set(this.comboBuffer);
        other.levelBuffer.set(this.levelBuffer);
        other.heap.set(this.heap);
        other.freeIds.set(this.freeIds);
        other.freeCount = this.freeCount;
        other._size = this._size;
        other._nextId = this._nextId;
        other.indexMap = new Map(this.indexMap);
        return other;
    }
}
