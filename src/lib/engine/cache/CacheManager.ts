import { LRUCache } from '#utils/collections/LRUCache.js';
import { CalculationStats, SearchFrontier, PackedEnchant, CacheStats, CacheConfig } from '#types/index.js';

/**
 * Centralized service for managing all engine-level caches.
 * Provides unified access, metrics tracking, and lifecycle control.
 */
export class CacheManager {
    private readonly dist = new Map<string, { [level: number]: bigint }>();
    private readonly pool: LRUCache<string, PackedEnchant[]>;
    private readonly itemFrontiers: LRUCache<string, SearchFrontier>;
    private readonly bookFrontiers: LRUCache<string, SearchFrontier>;
    private readonly stats: LRUCache<string, CalculationStats>;

    private metrics = {
        dist: { hits: 0, misses: 0 },
        pool: { hits: 0, misses: 0 },
        itemFrontiers: { hits: 0, misses: 0 },
        bookFrontiers: { hits: 0, misses: 0 },
        stats: { hits: 0, misses: 0 }
    };

    /**
     * Initializes a new CacheManager with custom or default limits.
     */
    constructor(config: CacheConfig) {
        this.pool = new LRUCache<string, PackedEnchant[]>(config.poolSize);
        this.itemFrontiers = new LRUCache<string, SearchFrontier>(config.comboOtherSize);
        this.bookFrontiers = new LRUCache<string, SearchFrontier>(config.comboBookSize);
        this.stats = new LRUCache<string, CalculationStats>(config.statsSize);
    }

    // --- Distribution Cache ---
    public getDist(version: string, key: string): { [level: number]: bigint } | undefined {
        const val = this.dist.get(`${version}:${key}`);
        if (val) this.metrics.dist.hits++; else this.metrics.dist.misses++;
        return val;
    }
    public setDist(version: string, key: string, val: { [level: number]: bigint }): void {
        this.dist.set(`${version}:${key}`, val);
    }

    // --- Pool Cache ---
    public getPool(version: string, key: string): PackedEnchant[] | undefined {
        const val = this.pool.get(`${version}:${key}`);
        if (val) this.metrics.pool.hits++; else this.metrics.pool.misses++;
        return val;
    }
    public setPool(version: string, key: string, val: PackedEnchant[]): void {
        this.pool.set(`${version}:${key}`, val);
    }

    // --- Frontier Cache ---
    private getItemFrontier(version: string, key: number): SearchFrontier | undefined {
        const val = this.itemFrontiers.get(`${version}:${key}`);
        if (val) this.metrics.itemFrontiers.hits++; else this.metrics.itemFrontiers.misses++;
        return val;
    }
    private setItemFrontier(version: string, key: number, val: SearchFrontier): void {
        this.itemFrontiers.set(`${version}:${key}`, val);
    }

    private getBookFrontier(version: string, key: number): SearchFrontier | undefined {
        const val = this.bookFrontiers.get(`${version}:${key}`);
        if (val) this.metrics.bookFrontiers.hits++; else this.metrics.bookFrontiers.misses++;
        return val;
    }
    private setBookFrontier(version: string, key: number, val: SearchFrontier): void {
        this.bookFrontiers.set(`${version}:${key}`, val);
    }

    /**
     * Unified accessor: routes to the book or item frontier cache based on item.
     * Centralizes the `item === "book"` branch that would otherwise be duplicated at call sites.
     */
    public getSearchState(item: string, version: string, key: number): SearchFrontier | undefined {
        return item === 'book' ? this.getBookFrontier(version, key) : this.getItemFrontier(version, key);
    }
    public setSearchState(item: string, version: string, key: number, val: SearchFrontier): void {
        if (item === 'book') this.setBookFrontier(version, key, val);
        else this.setItemFrontier(version, key, val);
    }

    // --- Stats Cache ---
    public getStats(version: string, key: number): CalculationStats | undefined {
        const val = this.stats.get(`${version}:${key}`);
        if (val) this.metrics.stats.hits++; else this.metrics.stats.misses++;
        return val;
    }
    public setStats(version: string, key: number, val: CalculationStats): void {
        this.stats.set(`${version}:${key}`, val);
    }

    // --- Lifecycle ---
    public clearAll(): void {
        this.dist.clear();
        this.pool.clear();
        this.itemFrontiers.clear();
        this.bookFrontiers.clear();
        this.stats.clear();
        this.resetMetrics();
    }

    public clearStats(): void {
        this.stats.clear();
        this.metrics.stats.hits = 0;
        this.metrics.stats.misses = 0;
    }

    public resetMetrics(): void {
        this.metrics.dist = { hits: 0, misses: 0 };
        this.metrics.pool = { hits: 0, misses: 0 };
        this.metrics.itemFrontiers = { hits: 0, misses: 0 };
        this.metrics.bookFrontiers = { hits: 0, misses: 0 };
        this.metrics.stats = { hits: 0, misses: 0 };
    }

    public getMetrics(): { [key: string]: CacheStats } {
        return {
            dist: { ...this.metrics.dist },
            pool: { ...this.metrics.pool },
            itemFrontiers: { ...this.metrics.itemFrontiers },
            bookFrontiers: { ...this.metrics.bookFrontiers },
            stats: { ...this.metrics.stats }
        };
    }

    /**
     * For internal engine metrics, merges item and book frontier caches into 'frontierCache'.
     */
    public getEngineMetrics(): { distCache: CacheStats; poolCache: CacheStats; frontierCache: CacheStats } {
        return {
            distCache: { ...this.metrics.dist },
            poolCache: { ...this.metrics.pool },
            frontierCache: {
                hits: this.metrics.itemFrontiers.hits + this.metrics.bookFrontiers.hits,
                misses: this.metrics.itemFrontiers.misses + this.metrics.bookFrontiers.misses
            }
        };
    }

    /** Returns total number of nodes cached in item and book frontiers. */
    public getTotalCachedNodes(): number {
        let count = 0;
        for (const f of this.itemFrontiers.values()) count += f.queue.size();
        for (const f of this.bookFrontiers.values()) count += f.queue.size();
        return count;
    }

    /** Returns total number of results cached in item and book frontiers. */
    public getTotalCachedResults(): number {
        let count = 0;
        for (const f of this.itemFrontiers.values()) count += f.results.size;
        for (const f of this.bookFrontiers.values()) count += f.results.size;
        return count;
    }
}
