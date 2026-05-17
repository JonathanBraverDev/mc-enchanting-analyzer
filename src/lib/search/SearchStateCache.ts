import { LRUCache } from '#utils/collections/LRUCache.js';
import { RegistryKernel, SearchPool } from '#lib/search/registry/RegistryKernel.js';
import { SearchGraph } from '#lib/search/SearchGraph.js';
import { SearchRun } from '#lib/search/SearchRun.js';
import { SearchExpansionBlueprintCache } from '#lib/search/SearchExpansionBlueprintCache.js';

/** LRU capacities for structural graphs and resumable search runs. */
export interface SearchStateCacheConfig {
    readonly graphSize?: number | undefined;
    readonly runSize?: number | undefined;
}

/** Hit/miss counters for one search-state cache partition. */
export interface SearchStateCacheStats {
    readonly hits: number;
    readonly misses: number;
}

/** Snapshot of SearchStateCache hit/miss counters. */
export interface SearchStateCacheMetrics {
    readonly graphs: SearchStateCacheStats;
    readonly runs: SearchStateCacheStats;
}

/**
 * LRU cache for the two reusable layers of shared search state.
 *
 * SearchGraph entries are structural only: lazy node identity and expansions for
 * a pool signature, without probability mass. SearchRun entries are XP-cell state:
 * frontier mass, resolved results, residue, and accounting that can be advanced by
 * later refinement calls.
 */
export class SearchStateCache {
    private readonly graphs: LRUCache<string, SearchGraph>;
    private readonly runs: LRUCache<string, SearchRun>;
    private readonly blueprints = new SearchExpansionBlueprintCache();

    private metrics = {
        graphs: { hits: 0, misses: 0 },
        runs: { hits: 0, misses: 0 }
    };

    public constructor(config: SearchStateCacheConfig = {}) {
        this.graphs = new LRUCache<string, SearchGraph>(config.graphSize ?? 256);
        this.runs = new LRUCache<string, SearchRun>(config.runSize ?? 128);
    }

    /** Returns the structural graph for a pool signature, creating it on a cache miss. */
    public getOrCreateGraph(kernel: RegistryKernel, pool: SearchPool, clueMode: string | null = null): SearchGraph {
        const key = this.createSearchGraphKey(kernel, pool, clueMode);
        const cached = this.graphs.get(key);
        if (cached) {
            this.metrics.graphs.hits++;
            return cached;
        }

        this.metrics.graphs.misses++;
        const graph = new SearchGraph(kernel, pool, { clueMode, blueprintCache: this.blueprints });
        this.graphs.set(key, graph);
        return graph;
    }

    /** Returns a resumable XP-cell run, creating it on a cache miss. */
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
        this.graphs.clear();
        this.runs.clear();
        this.blueprints.clear();
        this.resetMetrics();
    }

    public resetMetrics(): void {
        this.metrics.graphs = { hits: 0, misses: 0 };
        this.metrics.runs = { hits: 0, misses: 0 };
    }

    public getMetrics(): SearchStateCacheMetrics {
        return {
            graphs: { ...this.metrics.graphs },
            runs: { ...this.metrics.runs }
        };
    }

    private createSearchGraphKey(kernel: RegistryKernel, pool: SearchPool, clueMode: string | null): string {
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
