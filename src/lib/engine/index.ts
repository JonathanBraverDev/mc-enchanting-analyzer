import { BuiltRegistryState, CalculationRequest, CalculationStats, CheckpointSearchRequest, EngineInstrumentation, SearchResult, SearchConfig, SequentialCheckpointSearchRequest } from '#types/index.js';
import { getItemId, getMaterialId, isItemAvailable, isMaterialEligible, getAvailablePool as getRegistryAvailablePool } from '#core/registry.js';
import { KeyUtils, ProbUtils } from '#utils/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { MINECRAFT_RULES } from '#constants/minecraft.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { SummaryService } from '#services/SummaryService.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchExecutionService } from '#lib/search/SearchExecutionService.js';
import { ClueValidator } from '#core/clue.js';
export { EngineFactory } from './factory.js';

/**
 * Core math and logic engine for Minecraft Enchanting.
 * Orchestrates distribution calculation, best-first search, and statistics aggregation.
 * Optimized for high-speed calculation via Dependency Injection.
 */
export class EnchantEngine {
    private readonly _registry: BuiltRegistryState;
    get registry(): BuiltRegistryState { return this._registry; }

    constructor(
        registry: BuiltRegistryState,
        private readonly cache: CacheManager,
        private readonly distributionService: ModifiedLevelDistributionService,
        private readonly searchService: SearchExecutionService = new SearchExecutionService(distributionService)
    ) {
        this._registry = registry;
    }

    /** Clears all engine-level caches. */
    public resetCaches(): void {
        this.cache.clearAll();
        this.searchService.clearCache();
    }

    /** Clears only the stats cache. */
    public resetStatsCache(): void {
        this.cache.clearStats();
    }

    /** Returns current cache performance metrics. */
    public getCacheMetrics(): { distCache: { hits: number; misses: number }; poolCache: { hits: number; misses: number }; statsCache: { hits: number; misses: number } } {
        return this.cache.getEngineMetrics();
    }

    public destroy(): void {
        // Shared caches are not cleared on destroy unless explicitly requested
    }

    /**
     * Retrieves the probability distribution of Modified Levels.
     */
    public getModifiedLevelDist(xp: number, enchantability: number, instrumentation?: EngineInstrumentation): { [level: number]: bigint } {
        return this.distributionService.getModifiedLevelDist(this.registry, xp, enchantability, this.cache, instrumentation);
    }

    /**
     * Returns a list of eligible enchantments filtered by conflict bitset.
     */
    public getAvailablePool(item: string, level: number, bitset: bigint = 0n): number[] {
        return getRegistryAvailablePool(this._registry, item, level, bitset, this.cache, this._registry.version);
    }

    /**
     * Runs one request through an ordered checkpoint plan and streams each completed checkpoint.
     */
    public async searchSequentialCheckpoints(request: SequentialCheckpointSearchRequest): Promise<SearchResult> {
        this.validateRequest(request);
        const { item, material } = request;
        const targetClueId = request.clue ? this.getPackedClue(item, request.clue) : undefined;

        return this.searchService.searchSequentialCheckpoints({
            ...request,
            item,
            material,
            registry: this.registry,
            targetClueId
        });
    }

    /**
     * Advances one checkpoint search request and returns the completed boundary state.
     */
    public async searchToCheckpoint(request: CheckpointSearchRequest): Promise<SearchResult> {
        this.validateRequest(request);
        const { item, material } = request;
        const targetClueId = request.clue ? this.getPackedClue(item, request.clue) : undefined;

        return this.searchService.searchToCheckpoint({
            ...request,
            item,
            material,
            registry: this.registry,
            targetClueId
        });
    }

    /**
     * Aggregates all statistics for a given enchantment attempt.
     * Use this for standard single-pass calculations (e.g. standard UI search).
     *
     * @param item The item type (e.g., 'sword', 'pickaxe').
     * @param xp The base XP level from the enchantment table (1-50).
     * @param material The item material (e.g., 'diamond', 'netherite').
     * @param config Optional search configuration (threshold, signals, etc).
     * @returns A promise resolving to the final aggregated statistics.
     */
    public async calculate(request: CalculationRequest): Promise<CalculationStats> {
        this.validateRequest(request);
        const { item, material } = request;

        const {
            xp,
            clue,
            threshold = ENGINE_LIMITS.DEFAULT_THRESHOLD,
            signal,
            onProgress,
            maxIterations,
            exhaustive,
            summaryLimit = ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
            resultsLimit = ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
            useCache,
            instrumentation,
            timing
        } = request;

        const packedClue = clue ? this.getPackedClue(item, clue) : null;
        const effectiveThreshold = exhaustive ? 0 : threshold;

        const cacheKey = this.getStatsKey(item, xp, material, packedClue);

        const cachedStats = useCache === false || exhaustive ? undefined : this.cache.getStats(this.registry.version, cacheKey);
        if (cachedStats && cachedStats.threshold <= effectiveThreshold) return cachedStats;

        const searchConfig: SearchConfig = {
            threshold: effectiveThreshold,
            signal,
            onProgress,
            maxIterations,
            exhaustive,
            resultsLimit,
            useCache,
            instrumentation,
            timing
        };

        const finalResult = await this.searchService.searchToCheckpoint({
            registry: this.registry,
            item,
            xp,
            material,
            targetClueId: packedClue ?? undefined,
            ...searchConfig
        });

        const isBook = item === "book";
        const postProcessingStart = timing ? performance.now() : 0;
        const finalStats = packedClue
            ? SummaryService.summarizeConditioned({
                combos: finalResult.combos,
                snapshot: finalResult.snapshot,
                indexToEnchant: this.registry.indexToEnchant,
                targetClueId: packedClue,
                comboLimit: summaryLimit,
                isBook
            })
            : SummaryService.summarize({
                combos: finalResult.combos,
                snapshot: finalResult.snapshot,
                indexToEnchant: this.registry.indexToEnchant,
                comboLimit: summaryLimit,
                threshold: finalResult.threshold,
                isBook
            });

        finalStats.instrumentation = finalResult.instrumentation;
        if (timing) {
            const postProcessingMs = performance.now() - postProcessingStart;
            timing.postProcessingMs = (timing.postProcessingMs ?? 0) + postProcessingMs;
            timing.totalMs += postProcessingMs;
            finalStats.timing = { ...timing };
        } else {
            finalStats.timing = finalResult.timing;
        }

        if (useCache !== false && !exhaustive) {
            const currentCached = this.cache.getStats(this.registry.version, cacheKey);
            if (!currentCached || finalStats.accuracy > currentCached.accuracy) {
                this.cache.setStats(this.registry.version, cacheKey, finalStats);
            }
        }

        return finalStats;
    }

    private getPackedClue(item: string, clue: string): number {
        return ClueValidator.validate(this.registry, item, clue);
    }

    private getStatsKey(item: string, xp: number, material: string, packedClue: number | null = null): number {
        const itemId = getItemId(this.registry, item);
        const materialId = getMaterialId(this.registry, material);

        let key = KeyUtils.getStatsKey(itemId, materialId, xp);
        if (packedClue !== null) {
            // Encode the clue into the high bits above the item/material/level fields.
            key += packedClue * (2 ** 18);
        }
        return key;
    }

    private validateRequest(request: CalculationRequest | CheckpointSearchRequest | SequentialCheckpointSearchRequest): void {
        const { item, material } = request;
        const { xp } = request;

        if (!Number.isFinite(xp) || !Number.isInteger(xp) || xp <= 0) {
            throw new Error(`Invalid XP level: ${xp}. XP must be a positive integer.`);
        }
        const xpCap = this.registry.mechanics.xp_cap ?? MINECRAFT_RULES.XP_CAP_LEGACY;
        if (xp > xpCap) {
            throw new Error(`XP level ${xp} exceeds the maximum of ${xpCap} for version ${this.registry.version}.`);
        }
        if (!isItemAvailable(this.registry, item)) {
            throw new Error(`Unknown or unavailable item: "${item}" in version ${this.registry.version}.`);
        }
        if (!isMaterialEligible(this.registry, item, material)) {
            throw new Error(`Material "${material}" is not available for item "${item}" in version ${this.registry.version}.`);
        }

        // Config validation
        if (request.threshold !== undefined) {
            const t = ProbUtils.toNumber(request.threshold);
            if (t < 0 || t > 1.0) {
                throw new Error(`Invalid threshold: ${t}. Threshold must be between 0 and 1.0.`);
            }
        }
        if (request.maxIterations !== undefined && (request.maxIterations <= 0 || !Number.isInteger(request.maxIterations))) {
            throw new Error(`Invalid maxIterations: ${request.maxIterations}. Must be a positive integer.`);
        }
        if ('checkpoints' in request) {
            for (const checkpoint of request.checkpoints) {
                if (checkpoint.targetClassifiedMass === undefined) continue;
                const target = ProbUtils.toNumber(checkpoint.targetClassifiedMass);
                if (target < 0 || target > 1.0) {
                    throw new Error(`Invalid checkpoint targetClassifiedMass: ${target}. Must be between 0 and 1.0.`);
                }
            }
        }
        if (request.resultsLimit !== undefined && (request.resultsLimit <= 0 || request.resultsLimit > 1_000_000)) {
            throw new Error(`Invalid resultsLimit: ${request.resultsLimit}. Must be between 1 and 1,000,000.`);
        }

    }
}
