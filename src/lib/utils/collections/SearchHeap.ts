import { POOL_CONSTANTS, BIGINT_CONSTANTS } from '#constants/engine.js';

/**
 * A specialized, TypedArray-backed priority queue for PackedNode data.
 * Optimized with:
 * 1. Interleaved memory layout (Stride-4) for cache locality and bitwise index math.
 * 2. Specialized Linear Probing Hash Table with tombstones for zero-allocation deduplication.
 * 3. D-Ary heap structure with hole percolation.
 */
export class SearchHeap {
    // Interleaved buffer: [meta (8B), prob (8B), combo (8B), hashIdx (8B)]
    private nodeBuffer = new BigUint64Array(0);
    private nodeBuffer32 = new Uint32Array(0); // 32-bit component view
    private comboView = new Float64Array(0);
    private static readonly STRIDE = 4; // layout: [meta (8B), prob (8B), combo (8B), hashIdx (8B)]

    private heap = new Uint32Array(0); // Stores dataId (index into buffers)

    // Hash Table for meta -> heapIdx
    private hashKeys = new BigUint64Array(0);
    private hashValues = new Int32Array(0); // Stores heapIdx, -1 for empty, -2 for tombstone
    private hashMask = 0;

    private _size: number = 0;
    private _nextId: number = 0;
    private capacity = 0;

    private freeIds = new Uint32Array(0);
    private freeCount: number = 0;

    constructor(initialCapacity: number = POOL_CONSTANTS.INITIAL_HEAP_CAPACITY) {
        // Hash table capacity is power-of-2, at least 2x capacity for 0.5 load factor
        let hashCap = 1;
        while (hashCap < initialCapacity * 2) hashCap <<= 1;

        this.reinitializeStorage(initialCapacity, hashCap);
    }

    private reinitializeStorage(capacity: number, hashCap: number): void {
        this.capacity = capacity;

        const buffer = new ArrayBuffer(capacity * SearchHeap.STRIDE * 8);
        this.nodeBuffer = new BigUint64Array(buffer);
        this.nodeBuffer32 = new Uint32Array(buffer);
        this.comboView = new Float64Array(buffer);

        this.heap = new Uint32Array(capacity);
        this.freeIds = new Uint32Array(capacity);

        this.hashMask = hashCap - 1;
        this.hashKeys = new BigUint64Array(hashCap);
        this.hashValues = new Int32Array(hashCap).fill(-1);

        this._size = 0;
        this._nextId = 0;
        this.freeCount = 0;
    }

    private getHash(meta: bigint): number {
        // Fast hashing using 32-bit components instead of BigInt ops
        const lo = Number(meta & 0xFFFFFFFFn);
        const hi = Number(meta >> 32n);
        let h = (lo ^ hi) >>> 0;
        h ^= h >>> 16;
        h = Math.imul(h, 0x85ebca6b);
        h ^= h >>> 13;
        h = Math.imul(h, 0xc2b2ae35);
        h ^= h >>> 16;
        return h & this.hashMask;
    }

    private findHashSlot(meta: bigint): { existingHeapIdx: number; hashIdx: number } {
        const startIdx = this.getHash(meta);
        let idx = startIdx;
        let firstTombstone = -1;

        do {
            const slot = this.hashValues[idx]!;

            if (slot === -1) {
                return {
                    existingHeapIdx: -1,
                    hashIdx: firstTombstone !== -1 ? firstTombstone : idx
                };
            }

            if (slot === -2) {
                if (firstTombstone === -1) firstTombstone = idx;
            } else if (this.hashKeys[idx] === meta) {
                return { existingHeapIdx: slot, hashIdx: idx };
            }

            idx = (idx + 1) & this.hashMask;
        } while (idx !== startIdx);

        return {
            existingHeapIdx: -1,
            hashIdx: firstTombstone
        };
    }

    private hashSet(meta: bigint, heapIdx: number): number {
        const { hashIdx } = this.findHashSlot(meta);
        if (hashIdx === -1) {
            throw new Error('SearchHeap hash table has no reusable slot during rehash.');
        }
        this.hashKeys[hashIdx] = meta;
        this.hashValues[hashIdx] = heapIdx;
        return hashIdx;
    }

    private hashDelete(meta: bigint): void {
        let idx = this.getHash(meta);
        while (this.hashValues[idx]! !== -1) {
            if (this.hashKeys[idx] === meta) {
                this.hashValues[idx] = -2; // Tombstone
                this.hashKeys[idx] = 0n;
                return;
            }
            idx = (idx + 1) & this.hashMask;
        }
    }

    private nextFreeId(): number {
        return this.freeIds[--this.freeCount]!;
    }

    public pushOrMerge(meta: bigint, prob: bigint, combo: number): void {
        const { existingHeapIdx, hashIdx } = this.findHashSlot(meta);

        if (existingHeapIdx !== -1) {
            const dataId = this.heap[existingHeapIdx]!;
            this.nodeBuffer[(dataId << 2) + 1]! += prob;
            this.bubbleUp(existingHeapIdx);
            return;
        }

        if (hashIdx === -1) {
            this.grow();
            this.pushOrMerge(meta, prob, combo);
            return;
        }

        if (this._nextId >= this.capacity && this.freeCount === 0) {
            this.grow();
            this.pushOrMerge(meta, prob, combo);
            return;
        }

        const dataId = this.freeCount > 0 ? this.nextFreeId() : this._nextId++;
        const base = dataId << 2; // Stride 4
        this.nodeBuffer[base] = meta;
        this.nodeBuffer[base + 1] = prob;
        this.comboView[base + 2] = combo;
        this.nodeBuffer32[(dataId << 3) + 6] = hashIdx; // Store hash index
        const heapIdx = this._size++;
        this.heap[heapIdx] = dataId;
        this.hashKeys[hashIdx] = meta;
        this.hashValues[hashIdx] = heapIdx;
        this.bubbleUp(heapIdx);
    }

    public popFast(out: { meta: bigint, prob: bigint, level: number, combo: number }): boolean {
        if (this._size === 0) return false;

        const dataId = this.heap[0]!;
        const base = dataId << 2;
        const meta = this.nodeBuffer[base]!;

        out.meta = meta;
        out.prob = this.nodeBuffer[base + 1]!;
        out.level = Number(meta & BIGINT_CONSTANTS.RANK_MASK);
        out.combo = this.comboView[base + 2]!;

        this.hashDelete(meta);
        this.freeIds[this.freeCount++] = dataId;

        const lastDataId = this.heap[--this._size]!;
        if (this._size > 0) {
            this.heap[0] = lastDataId;
            const lastHashIdx = this.nodeBuffer32[(lastDataId << 3) + 6]!;
            this.hashValues[lastHashIdx] = 0;
            this.sinkDown(0);
        }

        return true;
    }

    public pop(): { meta: bigint, prob: bigint, level: number, combo: number } | undefined {
        const res = { meta: 0n, prob: 0n, level: 0, combo: 0 };
        if (this.popFast(res)) return res;
        return undefined;
    }

    public peekProb(): bigint {
        return this._size > 0 ? (this.nodeBuffer[(this.heap[0]! << 2) + 1] ?? 0n) : 0n;
    }

    public size(): number {
        return this._size;
    }

    public get indexMapSize(): number {
        let count = 0;
        for (let i = 0; i < this.hashValues.length; i++) {
            if (this.hashValues[i]! >= 0) count++;
        }
        return count;
    }

    private bubbleUp(idx: number): void {
        const dataId = this.heap[idx]!;
        const prob = this.nodeBuffer[(dataId << 2) + 1]!;

        while (idx > 0) {
            const parentIdx = (idx - 1) >>> 2;
            const parentDataId = this.heap[parentIdx]!;
            if (prob <= this.nodeBuffer[(parentDataId << 2) + 1]!) break;

            this.heap[idx] = parentDataId;
            // O(1) hash table update (no hashing)
            const parentHashIdx = this.nodeBuffer32[(parentDataId << 3) + 6]!;
            this.hashValues[parentHashIdx] = idx;
            idx = parentIdx;
        }

        this.heap[idx] = dataId;
        const currentHashIdx = this.nodeBuffer32[(dataId << 3) + 6]!;
        this.hashValues[currentHashIdx] = idx;
    }

    private sinkDown(idx: number): void {
        const dataId = this.heap[idx]!;
        const prob = this.nodeBuffer[(dataId << 2) + 1]!;

        while (true) {
            let swapIdx = -1;
            let maxProb = prob;

            const firstChildIdx = (idx << 2) + 1;
            const lastChildIdx = firstChildIdx + 4;

            for (let i = firstChildIdx; i < lastChildIdx && i < this._size; i++) {
                const childDataId = this.heap[i]!;
                const childProb = this.nodeBuffer[(childDataId << 2) + 1]!;
                if (childProb > maxProb) {
                    maxProb = childProb;
                    swapIdx = i;
                }
            }

            if (swapIdx === -1) break;

            const swapDataId = this.heap[swapIdx]!;
            this.heap[idx] = swapDataId;
            const swapHashIdx = this.nodeBuffer32[(swapDataId << 3) + 6]!;
            this.hashValues[swapHashIdx] = idx;
            idx = swapIdx;
        }

        this.heap[idx] = dataId;
        const currentHashIdx = this.nodeBuffer32[(dataId << 3) + 6]!;
        this.hashValues[currentHashIdx] = idx;
    }

    public forEach(callback: (meta: bigint, prob: bigint, combo: number) => void): void {
        for (let i = 0; i < this._size; i++) {
            const dataId = this.heap[i]!;
            const base = dataId << 2;
            callback(
                this.nodeBuffer[base]!,
                this.nodeBuffer[base + 1]!,
                Number(this.comboView[base + 2])
            );
        }
    }

    private grow(): void {
        const oldCapacity = this.capacity;
        const newCapacity = oldCapacity * 2;
        this.capacity = newCapacity;

        const oldBuffer = this.nodeBuffer.buffer;
        const newBuffer = new ArrayBuffer(newCapacity * SearchHeap.STRIDE * 8);
        new BigUint64Array(newBuffer).set(new BigUint64Array(oldBuffer));

        this.nodeBuffer = new BigUint64Array(newBuffer);
        this.nodeBuffer32 = new Uint32Array(newBuffer);
        this.comboView = new Float64Array(newBuffer);

        const newHeap = new Uint32Array(newCapacity);
        newHeap.set(this.heap);
        this.heap = newHeap;

        const newFree = new Uint32Array(newCapacity);
        newFree.set(this.freeIds);
        this.freeIds = newFree;

        // Rehash
        const newHashCap = this.hashKeys.length * 2;
        this.hashMask = newHashCap - 1;
        const oldValues = this.hashValues;

        this.hashKeys = new BigUint64Array(newHashCap);
        this.hashValues = new Int32Array(newHashCap).fill(-1);

        for (let i = 0; i < oldValues.length; i++) {
            if (oldValues[i]! >= 0) {
                const heapIdx = oldValues[i]!;
                const dataId = this.heap[heapIdx]!;
                const meta = this.nodeBuffer[dataId << 2]!;
                const newHashIdx = this.hashSet(meta, heapIdx);
                this.nodeBuffer32[(dataId << 3) + 6] = newHashIdx;
            }
        }
    }

    /**
     * Required for cache serialization/cloning.
     */
    public clone(): SearchHeap {
        const other = new SearchHeap(this.capacity);
        this.copyTo(other);
        return other;
    }

    public copyTo(other: SearchHeap): void {
        if (other.capacity !== this.capacity || other.hashKeys.length !== this.hashKeys.length) {
            other.reinitializeStorage(this.capacity, this.hashKeys.length);
        }

        other.nodeBuffer.set(this.nodeBuffer);
        other.heap.set(this.heap);
        other.freeIds.set(this.freeIds);
        other.freeCount = this.freeCount;
        other._size = this._size;
        other._nextId = this._nextId;
        other.capacity = this.capacity;
        other.hashMask = this.hashMask;
        other.hashKeys.set(this.hashKeys);
        other.hashValues.set(this.hashValues);
    }
}
