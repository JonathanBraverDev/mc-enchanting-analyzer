/**
 * Lightweight Binary Heap for priority queue operations.
 */
export class BinaryHeap<T extends { prob: bigint }> {
    private heap: T[] = [];
    private indexMap: Map<bigint, number> = new Map();
    private idSelector: ((item: T) => bigint) | null = null;

    constructor(idSelector: ((item: T) => bigint) | null = null) {
        this.idSelector = idSelector;
    }

    private at(idx: number): T {
        return this.heap[idx]!;
    }

    push(item: T) {
        if (this.idSelector) {
            const id = this.idSelector(item);
            const idx = this.indexMap.get(id);
            if (idx !== undefined) {
                this.at(idx).prob += item.prob;
                this.bubbleUp(idx);
                return;
            }
            this.indexMap.set(id, this.heap.length);
        }
        this.heap.push(item);
        this.bubbleUp(this.heap.length - 1);
    }

    /**
     * High-performance alternative to push() that avoids object allocation if node exists.
     */
    pushOrMerge(id: bigint, prob: bigint, dataFactory: () => T) {
        if (!this.idSelector) {
            const item = dataFactory();
            this.heap.push(item);
            this.bubbleUp(this.heap.length - 1);
            return;
        }

        const idx = this.indexMap.get(id);
        if (idx !== undefined) {
            this.at(idx).prob += prob;
            this.bubbleUp(idx);
            return;
        }

        const item = dataFactory();
        this.indexMap.set(id, this.heap.length);
        this.heap.push(item);
        this.bubbleUp(this.heap.length - 1);
    }


    pop(): T | undefined {
        const length = this.heap.length;
        if (length === 0) return undefined;

        const top = this.at(0);
        const idSelector = this.idSelector;
        if (idSelector) {
            this.indexMap.delete(idSelector(top));
        }

        const bottom = this.heap.pop();
        if (this.heap.length > 0 && bottom !== undefined) {
            this.heap[0] = bottom;
            if (idSelector) {
                this.indexMap.set(idSelector(bottom), 0);
            }
            this.sinkDown(0);
        }
        return top;
    }


    size(): number {
        return this.heap.length;
    }

    peek(): T | undefined {
        return this.heap[0];
    }

    get items(): T[] {
        return this.heap;
    }

    get indexMapSize(): number {
        return this.idSelector ? this.indexMap.size : 0;
    }

    private bubbleUp(idx: number) {
        const element = this.at(idx);
        const prob = element.prob;
        const idSelector = this.idSelector;
        const id = idSelector ? idSelector(element) : null;

        while (idx > 0) {
            const parentIdx = (idx - 1) >>> 1;
            const parent = this.at(parentIdx);

            if (prob <= parent.prob) break;

            this.heap[idx] = parent;
            if (idSelector) {
                this.indexMap.set(idSelector(parent), idx);
            }
            idx = parentIdx;
        }

        this.heap[idx] = element;
        if (idSelector && id !== null) {
            this.indexMap.set(id, idx);
        }
    }


    private sinkDown(idx: number) {
        const length = this.heap.length;
        const element = this.at(idx);
        const prob = element.prob;
        const idSelector = this.idSelector;
        const id = idSelector ? idSelector(element) : null;

        while (true) {
            let leftChildIdx = (idx << 1) + 1;
            let rightChildIdx = (idx << 1) + 2;
            let swapIdx = -1;
            let maxProb = prob;

            if (leftChildIdx < length) {
                const leftChild = this.at(leftChildIdx);
                if (leftChild.prob > maxProb) {
                    maxProb = leftChild.prob;
                    swapIdx = leftChildIdx;
                }
            }

            if (rightChildIdx < length) {
                const rightChild = this.at(rightChildIdx);
                if (rightChild.prob > maxProb) {
                    swapIdx = rightChildIdx;
                }
            }

            if (swapIdx === -1) break;

            const swapElement = this.at(swapIdx);
            this.heap[idx] = swapElement;
            if (idSelector) {
                this.indexMap.set(idSelector(swapElement), idx);
            }
            idx = swapIdx;
        }

        this.heap[idx] = element;
        if (idSelector && id !== null) {
            this.indexMap.set(id, idx);
        }
    }


    clone(): BinaryHeap<T> {
        const newHeap = new BinaryHeap<T>(this.idSelector);
        newHeap.heap = [...this.heap];
        newHeap.indexMap = new Map(this.indexMap);
        return newHeap;
    }
}
