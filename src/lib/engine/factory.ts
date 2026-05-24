import { BuiltRegistryState } from '#types/index.js';
import { DefaultEnchantEngine, type EnchantEngine } from '#engine/index.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { CACHE_CONFIG } from '#constants/engine.js';
import { RegistryFactory } from '#core/factory.js';

/**
 * Factory for creating Enchantment Engine instances with default dependencies.
 *
 * @public
 */
export class EngineFactory {
    private static readonly instances = new Map<string, EnchantEngine>();

    /**
     * Creates or retrieves a fully-wired EnchantEngine for the given version.
     * Reuses instances to optimize registry building and cache warming.
     */
    public static createForVersion(version: string): EnchantEngine {
        const cacheKey = version;
        if (this.instances.has(cacheKey)) {
            return this.instances.get(cacheKey)!;
        }

        const registry = RegistryFactory.build(version);
        const engine = this.create(registry);

        this.instances.set(cacheKey, engine);
        return engine;
    }

    /**
     * Creates a fully-wired engine around an already resolved registry.
     */
    public static create(registry: BuiltRegistryState): EnchantEngine {
        const cache = new CacheManager({
            comboOtherSize: CACHE_CONFIG.COMBO_OTHER_SIZE,
            comboBookSize: CACHE_CONFIG.COMBO_BOOK_SIZE,
            poolSize: CACHE_CONFIG.POOL_SIZE
        });

        const distributionService = new ModifiedLevelDistributionService(1024);
        const engine = new DefaultEnchantEngine(
            registry,
            cache,
            distributionService
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
