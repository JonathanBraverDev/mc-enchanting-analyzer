import { LRUCache } from '../utils/collections/LRUCache.js';
import { CalculationStats, SearchFrontier, PackedEnchant, CacheStats, CacheConfig } from '../types/index.js';

/**
 * Centralized service for managing all engine-level caches.
 * Provides unified access, metrics tracking, and lifecycle control.
 */
export class CacheManager {
    private readonly dist = new Map<string, { [level: number]: bigint }>();
    private readonly pool: LRUCache<string, PackedEnchant[]>;
    private readonly combo: LRUCache<string, SearchFrontier>;
    private readonly book: LRUCache<string, SearchFrontier>;
    private readonly stats: LRUCache<string, CalculationStats>;

    private metrics = {
        dist: { hits: 0, misses: 0 },
        pool: { hits: 0, misses: 0 },
        combo: { hits: 0, misses: 0 },
        book: { hits: 0, misses: 0 },
        stats: { hits: 0, misses: 0 }
    };

    /**
     * Initializes a new CacheManager with custom or default limits.
     */
    constructor(config: CacheConfig) {
        this.pool = new LRUCache<string, PackedEnchant[]>(config.poolSize);
        this.combo = new LRUCache<string, SearchFrontier>(config.comboOtherSize);
        this.book = new LRUCache<string, SearchFrontier>(config.comboBookSize);
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

    // --- Combo / Frontier Cache ---
    public getCombo(version: string, key: number): SearchFrontier | undefined {
        const val = this.combo.get(`${version}:${key}`);
        if (val) this.metrics.combo.hits++; else this.metrics.combo.misses++;
        return val;
    }
    public setCombo(version: string, key: number, val: SearchFrontier): void {
        this.combo.set(`${version}:${key}`, val);
    }

    public getBook(version: string, key: number): SearchFrontier | undefined {
        const val = this.book.get(`${version}:${key}`);
        if (val) this.metrics.book.hits++; else this.metrics.book.misses++;
        return val;
    }
    public setBook(version: string, key: number, val: SearchFrontier): void {
        this.book.set(`${version}:${key}`, val);
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
        this.combo.clear();
        this.book.clear();
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
        this.metrics.combo = { hits: 0, misses: 0 };
        this.metrics.book = { hits: 0, misses: 0 };
        this.metrics.stats = { hits: 0, misses: 0 };
    }

    public getMetrics(): { [key: string]: CacheStats } {
        return {
            dist: { ...this.metrics.dist },
            pool: { ...this.metrics.pool },
            combo: { ...this.metrics.combo },
            book: { ...this.metrics.book },
            stats: { ...this.metrics.stats }
        };
    }

    /**
     * For internal engine metrics, merges combo and book caches into 'frontierCache'.
     */
    public getEngineMetrics(): { distCache: CacheStats; poolCache: CacheStats; frontierCache: CacheStats } {
        return {
            distCache: { ...this.metrics.dist },
            poolCache: { ...this.metrics.pool },
            frontierCache: {
                hits: this.metrics.combo.hits + this.metrics.book.hits,
                misses: this.metrics.combo.misses + this.metrics.book.misses
            }
        };
    }

    /** Returns total number of nodes cached in both combo and book frontiers. */
    public getTotalCachedNodes(): number {
        let count = 0;
        for (const f of this.combo.values()) count += f.queue.size();
        for (const f of this.book.values()) count += f.queue.size();
        return count;
    }

    /** Returns total number of results cached in both combo and book frontiers. */
    public getTotalCachedResults(): number {
        let count = 0;
        for (const f of this.combo.values()) count += f.results.size;
        for (const f of this.book.values()) count += f.results.size;
        return count;
    }
}
