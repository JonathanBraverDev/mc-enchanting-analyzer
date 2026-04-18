import { UI_CONSTANTS } from '#constants/engine.js';

/**
 * Simple LRU Cache implementation using Map's insertion order.
 */
export class LRUCache<K, V> {
    private cache = new Map<K, V>();
    private maxEntries: number;

    constructor(maxEntries: number = UI_CONSTANTS.DEFAULT_LRU_MAX_ENTRIES) {
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

    values(): IterableIterator<V> {
        return this.cache.values();
    }

    entries(): IterableIterator<[K, V]> {
        return this.cache.entries();
    }
}
