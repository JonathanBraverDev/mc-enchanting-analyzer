import { EnchantmentData, RegistryState } from '#types/index.js';
import { EnchantEngine } from './index.js';
import { CacheManager } from './cache/CacheManager.js';
import { KeyService } from '#services/KeyService.js';
import { PoolService } from '#services/PoolService.js';
import { DistributionService } from './distribution/DistributionService.js';
import { SearchService } from './search/SearchService.js';
import { StatAggregator } from './aggregation/StatAggregator.js';
import { CACHE_CONFIG } from '#constants/engine.js';
import { RegistryFactory } from '#core/factory.js';

export interface EngineDependencies {
    registry: RegistryState;
    cache: CacheManager;
    keyService: KeyService;
    poolService: PoolService;
    distributionService: DistributionService;
    searchService: SearchService;
    statAggregator: StatAggregator;
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
    public static create(data: EnchantmentData, version: string, overrides: Partial<EngineDependencies> = {}): EnchantEngine {
        const cacheKey = version;
        if (this.instances.has(cacheKey) && Object.keys(overrides).length === 0) {
            return this.instances.get(cacheKey)!;
        }

        const registry = overrides.registry || RegistryFactory.build(data, version);
        
        const cache = overrides.cache || new CacheManager({
            comboOtherSize: CACHE_CONFIG.COMBO_OTHER_SIZE,
            comboBookSize: CACHE_CONFIG.COMBO_BOOK_SIZE,
            statsSize: CACHE_CONFIG.STATS_SIZE,
            poolSize: CACHE_CONFIG.POOL_SIZE
        });

        const keyService = overrides.keyService || new KeyService();
        const poolService = overrides.poolService || new PoolService(cache);
        const distributionService = overrides.distributionService || new DistributionService(1024);
        const searchService = overrides.searchService || new SearchService(cache);
        const statAggregator = overrides.statAggregator || new StatAggregator(cache, distributionService, searchService);

        const engine = new EnchantEngine(
            registry,
            cache,
            keyService,
            poolService,
            distributionService,
            searchService,
            statAggregator
        );

        if (Object.keys(overrides).length === 0) {
            this.instances.set(cacheKey, engine);
        }
        return engine;
    }

    /**
     * Clears the internal instance cache.
     */
    public static clearCaches(): void {
        this.instances.clear();
    }
}
