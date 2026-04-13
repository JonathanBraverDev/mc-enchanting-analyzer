import { LRUCache } from '../utils/collections/LRUCache.js';
import { CACHE_CONFIG } from '../constants/engine.js';
import { CalculationStats, SearchFrontier, PackedEnchant, CacheStats } from '../types/index.js';

/**
 * Centralized service for managing all engine-level caches.
 * Provides unified access, metrics tracking, and lifecycle control.
 */
export class CacheManager {
    private static instance: CacheManager;

    private readonly dist = new Map<string, { [level: number]: bigint }>();
    private readonly pool = new LRUCache<string, PackedEnchant[]>(CACHE_CONFIG.POOL_SIZE);
    private readonly combo = new LRUCache<string, SearchFrontier>(CACHE_CONFIG.COMBO_OTHER_SIZE);
    private readonly book = new LRUCache<string, SearchFrontier>(CACHE_CONFIG.COMBO_BOOK_SIZE);
    private readonly stats = new LRUCache<string, CalculationStats>(CACHE_CONFIG.STATS_SIZE);

    private metrics = {
        dist: { hits: 0, misses: 0 },
        pool: { hits: 0, misses: 0 },
        combo: { hits: 0, misses: 0 },
        book: { hits: 0, misses: 0 },
        stats: { hits: 0, misses: 0 }
    };

    private constructor() {}

    public static getInstance(): CacheManager {
        if (!CacheManager.instance) {
            CacheManager.instance = new CacheManager();
        }
        return CacheManager.instance;
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
}

export const cacheManager = CacheManager.getInstance();
