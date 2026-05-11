import { LRUCache } from '#utils/collections/LRUCache.js';
import { PackedEnchant, CacheStats, CacheConfig } from '#types/index.js';

/**
 * Centralized service for managing all engine-level caches.
 * Provides unified access, metrics tracking, and lifecycle control.
 */
export class CacheManager {
    private readonly dist = new Map<string, { [level: number]: bigint }>();
    private readonly pool: LRUCache<string, PackedEnchant[]>;

    private metrics = {
        dist: { hits: 0, misses: 0 },
        pool: { hits: 0, misses: 0 }
    };

    /**
     * Initializes a new CacheManager with custom or default limits.
     */
    constructor(config: CacheConfig) {
        this.pool = new LRUCache<string, PackedEnchant[]>(config.poolSize);
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

    // --- Lifecycle ---
    public clearAll(): void {
        this.dist.clear();
        this.pool.clear();
        this.resetMetrics();
    }

    public resetMetrics(): void {
        this.metrics.dist = { hits: 0, misses: 0 };
        this.metrics.pool = { hits: 0, misses: 0 };
    }

    public getMetrics(): { [key: string]: CacheStats } {
        return {
            dist: { ...this.metrics.dist },
            pool: { ...this.metrics.pool }
        };
    }

    /**
     * Returns cache metrics using the public EngineInstrumentation cache field names.
     */
    public getEngineMetrics(): { distCache: CacheStats; poolCache: CacheStats } {
        return {
            distCache: { ...this.metrics.dist },
            poolCache: { ...this.metrics.pool }
        };
    }

}