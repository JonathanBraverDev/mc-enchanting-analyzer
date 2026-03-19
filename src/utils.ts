/**
 * High-precision constant for BigInt fixed-point arithmetic (2^60)
 */
export const PRECISION = 1n << 60n;

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
 * Probability conversion helpers for BigInt fixed-point arithmetic.
 */
export const ProbUtils = {
    /**
     * Converts a floating-point probability to a BigInt fixed-point value.
     */
    toBigInt: (p: number): bigint => BigInt(Math.floor(p * Number(PRECISION))),

    /**
     * Converts a BigInt fixed-point value back to a floating-point probability.
     */
    toNumber: (b: bigint): number => Number(b) / Number(PRECISION)
};

/**
 * Lightweight Binary Heap for priority queue operations.
 * Optimized for objects with a BigInt 'prob' property and unique IDs.
 */
export class BinaryHeap<T extends { prob: bigint }> {
    private heap: T[] = [];
    private indexMap: Map<any, number> = new Map();
    private idSelector: ((item: T) => any) | null = null;

    constructor(idSelector: ((item: T) => any) | null = null) {
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

    private bubbleUp(idx: number) {
        const element = this.heap[idx];
        const id = this.idSelector ? this.idSelector(element) : null;

        while (idx > 0) {
            let parentIdx = Math.floor((idx - 1) / 2);
            let parent = this.heap[parentIdx];
            if (element.prob <= parent.prob) break;
            
            this.heap[parentIdx] = element;
            this.heap[idx] = parent;
            
            if (this.idSelector) {
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
                    (swap !== null && rightChild.prob > leftChild!.prob)
                ) {
                    swap = rightChildIdx;
                }
            }

            if (swap === null) break;
            
            const swapElement = this.heap[swap];
            this.heap[idx] = swapElement;
            this.heap[swap] = element;
            
            if (this.idSelector) {
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

/**
 * Simple LRU Cache implementation using Map's insertion order.
 */
export class LRUCache<K, V> {
    private cache = new Map<K, V>();
    private maxEntries: number;

    constructor(maxEntries: number = 500) {
        this.maxEntries = maxEntries;
    }

    get(key: K): V | undefined {
        const item = this.cache.get(key);
        if (item !== undefined) {
            // Refresh order
            this.cache.delete(key);
            this.cache.set(key, item);
        }
        return item;
    }

    set(key: K, value: V): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxEntries) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    has(key: K): boolean {
        return this.cache.has(key);
    }

    clear(): void {
        this.cache.clear();
    }

    get size(): number {
        return this.cache.size;
    }
}

/**
 * Type aliases for clarify in enchantment engine logic.
 * PackedEnchant: (id << 8 | rank)
 * PackedCombo: (count << 60 | slot0 << 0 | slot1 << 12 | ...)
 */
export type PackedEnchant = number;
export type PackedCombo = bigint;


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

/**
 * Interface for resolving enchantment names from IDs.
 */
export interface NameResolver {
    getFullEnchantName(n: number): string;
    getEnchantName(id: number): string;
}

/**
 * Utility for packing and unpacking enchantment combinations into BigInts.
 */
export class ComboUtils {
    /**
     * Packs a set of enchantments into a bigint.
     * Each enchantment is (id << 4 | rank), 12 bits total.
     */
    static pack(chosen: PackedEnchant[], guaranteedFirstId: number | null): PackedCombo {
        if (chosen.length === 0) return 0n;
        
        let firstPicked: number | null = null;
        const others: number[] = [];
        
        for (const c of chosen) {
            const id = c >> 8;
            const rank = c & 0xFF;
            const val = (id << 4) | (rank & 0x0F);
            if (guaranteedFirstId !== null && id === guaranteedFirstId && firstPicked === null) {
                firstPicked = val;
            } else {
                others.push(val);
            }
        }
        
        others.sort((a, b) => b - a);
        if (firstPicked !== null) others.unshift(firstPicked);
        
        let packed = 0n;
        for (let i = 0; i < others.length; i++) {
            packed |= BigInt(others[i]) << BigInt(i * 12);
        }
        packed |= BigInt(others.length) << 60n;
        
        return packed;
    }

    /**
     * Unpacks a bigint back into numeric enchantment IDs (id << 8 | rank).
     */
    static unpack(packed: PackedCombo): PackedEnchant[] {
        if (packed === 0n) return [];
        const count = Number(packed >> 60n);
        const core = packed & ((1n << 60n) - 1n);
        
        const out: PackedEnchant[] = [];
        for (let i = 0; i < count; i++) {
            const val = Number((core >> BigInt(i * 12)) & 0xFFFn);
            const id = val >> 4;
            const rank = val & 0x0F;
            out.push((id << 8) | rank);
        }
        return out;
    }
}

/**
 * Compact representation of calculation statistics for efficient transfer.
 */
export interface CompactStats {
    comboKeys: BigUint64Array;
    comboProbs: Float64Array;
    rankKeys: Uint32Array;
    rankProbs: Float64Array;
    anyKeys: Uint32Array;
    anyProbs: Float64Array;
    counts: Float64Array;
    uncertainty: number;
}

/**
 * Handles statistical transformations, humanization, and compact serialization.
 */
export class ResultProcessor {
    /**
     * Summarizes raw engine results into a CalculationStats-like object.
     * combos: Map<PackedCombo, bigint>
     */
    static summarize(combos: Map<PackedCombo, bigint>, uncertainty: bigint): any {
        const stats: any = {
            ranks: {},
            any: {},
            count: {},
            combos: {},
            uncertainty: ProbUtils.toNumber(uncertainty)
        };

        for (const [packed, probBig] of combos) {
            const prob = ProbUtils.toNumber(probBig);
            stats.combos[packed.toString(16)] = prob;
            
            const ids = ComboUtils.unpack(packed);
            stats.count[ids.length] = (stats.count[ids.length] || 0) + prob;

            let seenBasesBitmask = 0n;
            for (const n of ids) {
                stats.ranks[n] = (stats.ranks[n] || 0) + prob;
                
                const baseId = n >> 8;
                if (!((seenBasesBitmask >> BigInt(baseId)) & 1n)) {
                    stats.any[baseId] = (stats.any[baseId] || 0) + prob;
                    seenBasesBitmask |= (1n << BigInt(baseId));
                }
            }
        }
        return stats;
    }

    /**
     * Converts raw statistics into a human-readable format.
     */
    static humanize(stats: any, resolver: NameResolver): any {
        const human: any = {
            ranks: {},
            any: {},
            count: { ...stats.count },
            combos: {},
            uncertainty: stats.uncertainty
        };

        for (const [idAndRank, prob] of Object.entries(stats.ranks)) {
            const name = resolver.getFullEnchantName(Number(idAndRank));
            human.ranks[name] = prob;
        }

        for (const [id, prob] of Object.entries(stats.any)) {
            const name = resolver.getEnchantName(Number(id));
            human.any[name] = prob;
        }

        for (const [packed, prob] of Object.entries(stats.combos)) {
            const ids = ComboUtils.unpack(BigInt("0x" + packed));
            const comboKey = ids.map(n => resolver.getFullEnchantName(n)).join("+");
            human.combos[comboKey] = prob;
        }

        return human;
    }

    /**
     * Serializes CalculationStats into a CompactStats object for zero-copy transfer.
     */
    static serialize(stats: any): { compact: CompactStats, transferables: ArrayBuffer[] } {
        const comboEntries = Object.entries(stats.combos);
        const comboKeys = new BigUint64Array(comboEntries.length);
        const comboProbs = new Float64Array(comboEntries.length);
        for (let i = 0; i < comboEntries.length; i++) {
            comboKeys[i] = BigInt("0x" + comboEntries[i][0]);
            comboProbs[i] = comboEntries[i][1] as number;
        }

        const rankEntries = Object.entries(stats.ranks);
        const rankKeys = new Uint32Array(rankEntries.length);
        const rankProbs = new Float64Array(rankEntries.length);
        for (let i = 0; i < rankEntries.length; i++) {
            rankKeys[i] = Number(rankEntries[i][0]);
            rankProbs[i] = rankEntries[i][1] as number;
        }

        const anyEntries = Object.entries(stats.any);
        const anyKeys = new Uint32Array(anyEntries.length);
        const anyProbs = new Float64Array(anyEntries.length);
        for (let i = 0; i < anyEntries.length; i++) {
            anyKeys[i] = Number(anyEntries[i][0]);
            anyProbs[i] = anyEntries[i][1] as number;
        }

        const counts = new Float64Array(8);
        for (let i = 0; i < 8; i++) counts[i] = (stats.count[i] || 0);

        const compact: CompactStats = {
            comboKeys, comboProbs,
            rankKeys, rankProbs,
            anyKeys, anyProbs,
            counts, uncertainty: stats.uncertainty
        };

        return {
            compact,
            transferables: [
                comboKeys.buffer, comboProbs.buffer,
                rankKeys.buffer, rankProbs.buffer,
                anyKeys.buffer, anyProbs.buffer,
                counts.buffer
            ]
        };
    }

    /**
     * Reconstructs CalculationStats from a CompactStats object.
     */
    static deserialize(compact: CompactStats): any {
        const stats: any = { ranks: {}, any: {}, count: {}, combos: {}, uncertainty: compact.uncertainty };
        
        for (let i = 0; i < compact.comboKeys.length; i++) {
            stats.combos[compact.comboKeys[i].toString(16)] = compact.comboProbs[i];
        }
        for (let i = 0; i < compact.rankKeys.length; i++) {
            stats.ranks[compact.rankKeys[i]] = compact.rankProbs[i];
        }
        for (let i = 0; i < compact.anyKeys.length; i++) {
            stats.any[compact.anyKeys[i]] = compact.anyProbs[i];
        }
        for (let i = 0; i < compact.counts.length; i++) {
            if (compact.counts[i] > 0) stats.count[i] = compact.counts[i];
        }
        
        return stats;
    }
}
