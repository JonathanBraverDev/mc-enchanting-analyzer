import { LRUCache } from '#utils/collections/LRUCache.js';
import { RegistryKernel, V7PoolProjection } from '#lib/v7/registry/RegistryKernel.js';
import { SearchProgram } from '#lib/v7/search/SearchProgram.js';
import { SearchRun } from '#lib/v7/search/SearchRun.js';

export interface V7CacheConfig {
    readonly programSize?: number | undefined;
    readonly runSize?: number | undefined;
}

export interface V7CacheStats {
    readonly hits: number;
    readonly misses: number;
}

export interface V7SearchCacheMetrics {
    readonly programs: V7CacheStats;
    readonly runs: V7CacheStats;
}

/**
 * V7-specific cache split along V7's natural boundaries.
 *
 * SearchProgram entries are structural only: lazy node identity and expansions for
 * a pool signature, without probability mass. SearchRun entries are XP-cell state:
 * frontier mass, resolved results, residue, and accounting that can be advanced by
 * later refinement calls.
 */
export class V7SearchCache {
    private readonly programs: LRUCache<string, SearchProgram>;
    private readonly runs: LRUCache<string, SearchRun>;

    private metrics = {
        programs: { hits: 0, misses: 0 },
        runs: { hits: 0, misses: 0 }
    };

    public constructor(config: V7CacheConfig = {}) {
        this.programs = new LRUCache<string, SearchProgram>(config.programSize ?? 256);
        this.runs = new LRUCache<string, SearchRun>(config.runSize ?? 128);
    }

    public getOrCreateProgram(kernel: RegistryKernel, pool: V7PoolProjection, clueMode: string | null = null): SearchProgram {
        const key = this.createProgramKey(kernel, pool, clueMode);
        const cached = this.programs.get(key);
        if (cached) {
            this.metrics.programs.hits++;
            return cached;
        }

        this.metrics.programs.misses++;
        const program = new SearchProgram(kernel, pool, { clueMode });
        this.programs.set(key, program);
        return program;
    }

    public getOrCreateRun(key: string, create: () => SearchRun): SearchRun {
        const cached = this.runs.get(key);
        if (cached) {
            this.metrics.runs.hits++;
            return cached;
        }

        this.metrics.runs.misses++;
        const run = create();
        this.runs.set(key, run);
        return run;
    }

    public clearRuns(): void {
        this.runs.clear();
        this.metrics.runs = { hits: 0, misses: 0 };
    }

    public clearAll(): void {
        this.programs.clear();
        this.runs.clear();
        this.resetMetrics();
    }

    public resetMetrics(): void {
        this.metrics.programs = { hits: 0, misses: 0 };
        this.metrics.runs = { hits: 0, misses: 0 };
    }

    public getMetrics(): V7SearchCacheMetrics {
        return {
            programs: { ...this.metrics.programs },
            runs: { ...this.metrics.runs }
        };
    }

    private createProgramKey(kernel: RegistryKernel, pool: V7PoolProjection, clueMode: string | null): string {
        const bookMode = kernel.item !== 'book'
            ? 'item'
            : kernel.multiEnchantBooks ? 'multi-book' : 'single-book';
        return JSON.stringify({
            version: kernel.version,
            item: kernel.item,
            poolSignature: pool.signature,
            bookMode,
            clueMode
        });
    }
}
