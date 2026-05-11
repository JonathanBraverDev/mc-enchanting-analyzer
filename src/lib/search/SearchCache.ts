import { LRUCache } from '#utils/collections/LRUCache.js';
import { RegistryKernel, PoolProjection } from '#lib/search/registry/RegistryKernel.js';
import { SearchProgram } from '#lib/search/SearchProgram.js';
import { SearchRun } from '#lib/search/SearchRun.js';

export interface SearchCacheConfig {
    readonly programSize?: number | undefined;
    readonly runSize?: number | undefined;
}

export interface SearchCacheStats {
    readonly hits: number;
    readonly misses: number;
}

export interface SearchCacheMetrics {
    readonly programs: SearchCacheStats;
    readonly runs: SearchCacheStats;
}

/**
 * Search cache split along the shared search engine's natural boundaries.
 *
 * SearchProgram entries are structural only: lazy node identity and expansions for
 * a pool signature, without probability mass. SearchRun entries are XP-cell state:
 * frontier mass, resolved results, residue, and accounting that can be advanced by
 * later refinement calls.
 */
export class SearchCache {
    private readonly programs: LRUCache<string, SearchProgram>;
    private readonly runs: LRUCache<string, SearchRun>;

    private metrics = {
        programs: { hits: 0, misses: 0 },
        runs: { hits: 0, misses: 0 }
    };

    public constructor(config: SearchCacheConfig = {}) {
        this.programs = new LRUCache<string, SearchProgram>(config.programSize ?? 256);
        this.runs = new LRUCache<string, SearchRun>(config.runSize ?? 128);
    }

    public getOrCreateProgram(kernel: RegistryKernel, pool: PoolProjection, clueMode: string | null = null): SearchProgram {
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

    public getMetrics(): SearchCacheMetrics {
        return {
            programs: { ...this.metrics.programs },
            runs: { ...this.metrics.runs }
        };
    }

    private createProgramKey(kernel: RegistryKernel, pool: PoolProjection, clueMode: string | null): string {
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
