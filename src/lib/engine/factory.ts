import { EnchantmentData } from '../types/index.js';
import { EnchantEngine } from './index.js';
import { CacheManager } from '../services/CacheManager.js';
import { KeyService } from '../services/KeyService.js';
import { PoolService } from '../services/PoolService.js';
import { DistributionService } from './distribution.js';
import { SearchService } from './search.js';
import { StatAggregator } from './aggregator.js';
import { CACHE_CONFIG } from '../constants/engine.js';

/**
 * Factory for creating Enchantment Engine instances with default dependencies.
 */
export class EngineFactory {
    private static readonly instances = new Map<string, EnchantEngine>();

    /**
     * Creates or retrieves a fully-wired EnchantEngine for the given version.
     * Reuses instances to optimize registry building and cache warming.
     */
    public static create(data: EnchantmentData, version: string, customConfig?: any): EnchantEngine {
        const cacheKey = version;
        if (this.instances.has(cacheKey)) {
            return this.instances.get(cacheKey)!;
        }

        const cacheConfig = {
            comboOtherSize: CACHE_CONFIG.COMBO_OTHER_SIZE,
            comboBookSize: CACHE_CONFIG.COMBO_BOOK_SIZE,
            statsSize: CACHE_CONFIG.STATS_SIZE,
            poolSize: CACHE_CONFIG.POOL_SIZE,
            ...customConfig
        };

        const cache = new CacheManager(cacheConfig);
        const keyService = new KeyService();
        const poolService = new PoolService(cache);
        const distributionService = new DistributionService(1024);
        const searchService = new SearchService(cache);
        const statAggregator = new StatAggregator(cache, distributionService, searchService);

        const engine = new EnchantEngine(
            data,
            version,
            cache,
            keyService,
            poolService,
            distributionService,
            searchService,
            statAggregator
        );

        this.instances.set(cacheKey, engine);
        return engine;
    }

    /**
     * Clears the internal instance cache.
     */
    public static clearCaches(): void {
        this.instances.clear();
    }
}
