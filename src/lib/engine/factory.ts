import { RegistryState } from '#types/index.js';
import { EnchantEngine } from '#engine/index.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchService } from '#engine/search/SearchService.js';
import { CACHE_CONFIG } from '#constants/engine.js';
import { RegistryFactory } from '#core/factory.js';

export interface EngineRuntimeOverrides {
    cache: CacheManager;
    distributionService: ModifiedLevelDistributionService;
    searchService: SearchService;
}

/**
 * Factory for creating Enchantment Engine instances with default dependencies.
 */
export class EngineFactory {
    private static readonly instances = new Map<string, EnchantEngine>();

    /**
     * Creates or retrieves a fully-wired EnchantEngine for the given version.
     * Reuses instances to optimize registry building and cache warming.
     */
    public static createForVersion(version: string, overrides: Partial<EngineRuntimeOverrides> = {}): EnchantEngine {
        const cacheKey = version;
        if (this.instances.has(cacheKey) && Object.keys(overrides).length === 0) {
            return this.instances.get(cacheKey)!;
        }

        const registry = RegistryFactory.build(version);
        const engine = this.create(registry, overrides);

        if (Object.keys(overrides).length === 0) {
            this.instances.set(cacheKey, engine);
        }
        return engine;
    }

    /**
     * Creates a fully-wired engine around an already resolved registry.
     */
    public static create(registry: RegistryState, overrides: Partial<EngineRuntimeOverrides> = {}): EnchantEngine {
        const cache = overrides.cache || new CacheManager({
            comboOtherSize: CACHE_CONFIG.COMBO_OTHER_SIZE,
            comboBookSize: CACHE_CONFIG.COMBO_BOOK_SIZE,
            statsSize: CACHE_CONFIG.STATS_SIZE,
            poolSize: CACHE_CONFIG.POOL_SIZE
        });

        const distributionService = overrides.distributionService || new ModifiedLevelDistributionService(1024);
        const searchService = overrides.searchService || new SearchService(cache, distributionService);

        const engine = new EnchantEngine(
            registry,
            cache,
            distributionService,
            searchService
        );
        return engine;
    }

    /**
     * Clears the internal instance cache.
     */
    public static clearCaches(): void {
        this.instances.clear();
    }
}
