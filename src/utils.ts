/**
 * Utility functions for version parsing and comparison.
 */
export const VersionUtils = {
    /**
     * Parses a version string into an array of numbers.
     * @param v - Version string (e.g., "1.8.9").
     * @returns Array of numbers.
     */
    parse: (v: string): number[] => (v.match(/\d+/g) || []).map(Number),

    /**
     * Compares two version strings.
     * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
     */
    compare: (v1: string, v2: string): number => {
        const p1 = VersionUtils.parse(v1);
        const p2 = VersionUtils.parse(v2);
        const maxLen = Math.max(p1.length, p2.length);
        for (let i = 0; i < maxLen; i++) {
            const a = p1[i] || 0;
            const b = p2[i] || 0;
            if (a > b) return 1;
            if (a < b) return -1;
        }
        return 0;
    },

    /**
     * Checks if a version is within a specific range.
     */
    isInRange: (target: string, start?: string, end: string = "99.9"): boolean => {
        if (!start) return true;
        return VersionUtils.compare(target, start) >= 0 && VersionUtils.compare(target, end) <= 0;
    }
};

/**
 * Lightweight Binary Heap for priority queue operations.
 * Optimized for objects with a numeric 'prob' property.
 */
export class BinaryHeap<T extends { prob: number }> {
    private heap: T[] = [];

    push(item: T) {
        this.heap.push(item);
        this.bubbleUp();
    }

    pop(): T | undefined {
        if (this.size() === 0) return undefined;
        const top = this.heap[0];
        const bottom = this.heap.pop();
        if (this.size() > 0 && bottom !== undefined) {
            this.heap[0] = bottom;
            this.sinkDown();
        }
        return top;
    }

    size(): number {
        return this.heap.length;
    }

    private bubbleUp() {
        let idx = this.heap.length - 1;
        const element = this.heap[idx];
        while (idx > 0) {
            let parentIdx = Math.floor((idx - 1) / 2);
            let parent = this.heap[parentIdx];
            if (element.prob <= parent.prob) break;
            this.heap[parentIdx] = element;
            this.heap[idx] = parent;
            idx = parentIdx;
        }
    }

    private sinkDown() {
        let idx = 0;
        const length = this.heap.length;
        const element = this.heap[0];
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
                    (swap !== null && rightChild.prob > leftChild!.prob)
                ) {
                    swap = rightChildIdx;
                }
            }

            if (swap === null) break;
            this.heap[idx] = this.heap[swap];
            this.heap[swap] = element;
            idx = swap;
        }
    }
}

/**
 * Utilities for handling Roman numerals and enchantment names.
 */
export class RomanUtils {
    /**
     * Converts a numeric rank to a Roman numeral based on the provided map.
     */
    static rankToRoman(rank: number, romanMap: { [key: string]: number }): string {
        return Object.keys(romanMap)[rank - 1] || rank.toString();
    }

    /**
     * Extracts Roman numeral value from a string using the provided map.
     */
    static getRomanValue(r: string, romanMap: { [key: string]: number }): number {
        return romanMap[r] || 0;
    }

    /**
     * Gets the base name of an enchantment (removes level).
     */
    static getBaseName(fullName: string, romanMap: { [key: string]: number }): string {
        const parts = fullName.split(" ");
        const last = parts[parts.length - 1];
        return Object.keys(romanMap).includes(last) ? parts.slice(0, -1).join(" ") : fullName;
    }
}
