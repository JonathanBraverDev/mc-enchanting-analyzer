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

    push(item: T) {
        if (this.idSelector) {
            const id = this.idSelector(item);
            if (this.indexMap.has(id)) {
                const idx = this.indexMap.get(id)!;
                this.heap[idx].prob += item.prob;
                this.bubbleUp(idx);
                this.sinkDown(idx);
                return;
            }
            this.indexMap.set(id, this.heap.length);
        }
        this.heap.push(item);
        this.bubbleUp(this.heap.length - 1);
    }

    pop(): T | undefined {
        if (this.size() === 0) return undefined;
        const top = this.heap[0];
        if (this.idSelector) this.indexMap.delete(this.idSelector(top));

        const bottom = this.heap.pop();
        if (this.size() > 0 && bottom !== undefined) {
            this.heap[0] = bottom;
            if (this.idSelector) this.indexMap.set(this.idSelector(bottom), 0);
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
        const element = this.heap[idx];
        const id = this.idSelector ? this.idSelector(element) : null;

        while (idx > 0) {
            let parentIdx = Math.floor((idx - 1) / 2);
            let parent = this.heap[parentIdx];
            if (element.prob <= parent.prob) break;
            
            this.heap[parentIdx] = element;
            this.heap[idx] = parent;
            
            if (this.idSelector && id !== null) {
                this.indexMap.set(id, parentIdx);
                this.indexMap.set(this.idSelector(parent), idx);
            }
            
            idx = parentIdx;
        }
    }

    private sinkDown(idx: number) {
        const length = this.heap.length;
        const element = this.heap[idx];
        const id = this.idSelector ? this.idSelector(element) : null;

        while (true) {
            let leftChildIdx = 2 * idx + 1;
            let rightChildIdx = 2 * idx + 2;
            let leftChild, rightChild;
            let swap = null;

            if (leftChildIdx < length) {
                leftChild = this.heap[leftChildIdx];
                if (leftChild.prob > element.prob) {
                    swap = leftChildIdx;
                }
            }

            if (rightChildIdx < length) {
                rightChild = this.heap[rightChildIdx];
                if (
                    (swap === null && rightChild.prob > element.prob) ||
                    (swap !== null && rightChild.prob > (leftChild as T).prob)
                ) {
                    swap = rightChildIdx;
                }
            }

            if (swap === null) break;
            
            const swapElement = this.heap[swap];
            this.heap[idx] = swapElement;
            this.heap[swap] = element;
            
            if (this.idSelector && id !== null) {
                this.indexMap.set(this.idSelector(swapElement), idx);
                this.indexMap.set(id, swap);
            }
            
            idx = swap;
        }
    }

    clone(): BinaryHeap<T> {
        const newHeap = new BinaryHeap<T>(this.idSelector);
        newHeap.heap = [...this.heap];
        newHeap.indexMap = new Map(this.indexMap);
        return newHeap;
    }
}
