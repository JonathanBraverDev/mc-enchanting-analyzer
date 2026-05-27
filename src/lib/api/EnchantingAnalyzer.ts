import { RegistryFactory } from '#core/factory.js';
import { getSearchCheckpointForRefinement } from '#core/config.js';
import { EngineFactory } from '#engine/factory.js';
import { HumanizationService } from '#services/HumanizationService.js';
import type {
    CheckpointSearchRequest,
    EnchantInsights,
    EnchantStats,
    EngineInstrumentation,
    ProgressUpdate,
    RegistryMutation,
    ResultSortMode,
    SearchTiming,
    VersionMechanics
} from '#types/index.js';
import type { EnchantEngine } from '#engine/index.js';

/**
 * Named search presets for package callers.
 *
 * @remarks
 * These presets map to the same checkpoint levels used by the hosted
 * application: `coarse` is the quickest bounded estimate, `standard` is the
 * normal default, and `deep` / `ultra` spend progressively more work on the
 * same request. `exhaustive` asks the engine to continue until the frontier is
 * empty, aborted, or the host process runs out of practical resources.
 *
 * @public
 */
export type AnalyzerSearchPreset = 'coarse' | 'standard' | 'deep' | 'ultra' | 'exhaustive';

/**
 * Advanced search controls accepted by {@link EnchantingAnalyzer}.
 *
 * @remarks
 * A `preset` installs one of the built-in checkpoint configurations, and any
 * explicit fields on the same object override that preset. This lets callers
 * start from a known mode such as `deep` and tune a single stop condition
 * without copying every engine knob.
 *
 * Numeric probability values are fractions from `0` to `1`. BigInt values use
 * the engine's fixed precision probability units and are mainly useful for
 * diagnostics or exact parity tests.
 *
 * @public
 */
export interface AnalyzerSearchControls {
    /** Base preset to apply before explicit overrides on this object. */
    preset?: AnalyzerSearchPreset | undefined;
    /** Stop when the largest remaining frontier node is below this probability mass. */
    threshold?: number | bigint | undefined;
    /** Stop once resolved or otherwise classified probability mass reaches this target. */
    targetClassifiedMass?: number | bigint | undefined;
    /** Maximum search graph node expansions before returning a partial result with pending mass. */
    maxIterations?: number | undefined;
    /** Forward-mass floor used to sieve tiny branches for diagnostics or parity checks. */
    probabilityFloor?: number | bigint | undefined;
    /** After an iteration stop, also process frontier nodes that have the same mass as the stop node. */
    drainEqualMassBand?: boolean | undefined;
    /** Request an exhaustive search rather than a bounded checkpoint-style search. */
    exhaustive?: boolean | undefined;
    /** Reuse compatible cached search state from earlier calls on the same analyzer. */
    useCache?: boolean | undefined;
}

/**
 * Search mode accepted by {@link EnchantingAnalyzer.stats} and
 * {@link EnchantingAnalyzer.insights}.
 *
 * @remarks
 * Pass a string for a common preset, or pass an object when a caller needs to
 * override specific search controls.
 *
 * @public
 */
export type AnalyzerSearchMode = AnalyzerSearchPreset | AnalyzerSearchControls;

/**
 * Input shared by raw and human-readable analyzer calls.
 *
 * @remarks
 * `item`, `material`, and `xp` describe the enchanting-table setup. `clue`,
 * when supplied, must be the exact displayed table clue such as
 * `Sharpness IV`; it is not a target or minimum-rank filter.
 *
 * Normal callers usually provide only the setup fields plus an optional
 * `search` preset. `summaryLimit: 0` is useful for scripts that only need
 * aggregate probabilities and want to skip combo rows.
 *
 * @public
 */
export interface AnalyzerRequest {
    /** Enchantable item key, such as `sword`, `book`, or `pickaxe`. */
    item: string;
    /** Material key, such as `diamond`, `book`, or `bow`. */
    material: string;
    /** Player XP level used by the enchanting-table roll. */
    xp: number;
    /** Optional exact displayed table clue, such as `Sharpness III`. */
    clue?: string | null | undefined;
    /** Named preset or explicit search controls. Defaults to the standard stats checkpoint. */
    search?: AnalyzerSearchMode | undefined;
    /** Abort signal for long-running bounded or exhaustive searches. */
    signal?: AbortSignal | undefined;
    /** Progress callback for host UIs that want intermediate search updates. */
    onProgress?: ((update: ProgressUpdate) => void) | undefined;
    /** Maximum number of combo rows to include; use `0` to omit combo rows. */
    summaryLimit?: number | undefined;
    /** Allow combo output above the normal safety cap, including every combo when no limit is set. */
    uncappedResults?: boolean | undefined;
    /** Timing accumulator for diagnostics and profiling tools. */
    timing?: SearchTiming | undefined;
    /** Instrumentation accumulator for diagnostics and profiling tools. */
    instrumentation?: EngineInstrumentation | undefined;
}

/**
 * Options for constructing an {@link EnchantingAnalyzer}.
 *
 * @public
 */
export interface AnalyzerOptions {
    /** Vanilla-data mutations applied before the registry and engine are built. */
    mutations?: RegistryMutation | RegistryMutation[] | undefined;
}

/**
 * Registry metadata exposed without the internal runtime lookup tables.
 *
 * @public
 */
export interface AnalyzerRegistryInfo {
    /** Requested Minecraft version key this analyzer was created for. */
    readonly version: string;
    /** Whether the analyzer uses bundled vanilla data or caller-supplied mutations. */
    readonly source: 'vanilla' | 'mutated';
    /** Version-specific enchanting mechanics selected for this registry. */
    readonly mechanics: VersionMechanics;
    /** Whether table-generated enchanted books may contain multiple enchantments. */
    readonly multiEnchantBooks: boolean;
}

/**
 * Hit/miss counters for one analyzer cache.
 *
 * @public
 */
export interface AnalyzerCacheCounter {
    /** Number of successful lookups served from this cache. */
    hits: number;
    /** Number of lookups that had to be computed and then inserted. */
    misses: number;
}

/**
 * Public cache counters exposed by {@link EnchantingAnalyzer.getCacheMetrics}.
 *
 * @public
 */
export interface AnalyzerCacheMetrics {
    /** Modified-level distribution cache counters. */
    distCache: AnalyzerCacheCounter;
    /** Enchantment pool cache counters. */
    poolCache: AnalyzerCacheCounter;
}

/**
 * Main package facade for Minecraft enchanting analysis.
 *
 * @remarks
 * Use this class as the supported package entry point. It hides the internal
 * registry and engine factories, applies the supported search controls, and
 * translates compact engine output into display-ready names when requested.
 *
 * `stats` returns compact machine-readable IDs and packed combo keys for
 * storage, scripts, or advanced processing. `insights` returns the same
 * probabilities translated into enchantment names and human-readable combo
 * labels. All returned probabilities are fractions from `0` to `1`.
 *
 * Keep an analyzer instance around when issuing related searches for the same
 * version; per-instance caches can be reused across compatible requests.
 *
 * @example
 * ```ts
 * import { EnchantingAnalyzer } from 'mc-enchanting-analyzer';
 *
 * const analyzer = EnchantingAnalyzer.forVersion('1.21');
 * const result = await analyzer.insights({
 *     item: 'pickaxe',
 *     material: 'diamond',
 *     xp: 30,
 *     search: 'deep',
 *     summaryLimit: 10
 * });
 *
 * console.log(result.combos);
 * ```
 *
 * @public
 */
export class EnchantingAnalyzer {
    private constructor(private readonly engine: EnchantEngine) {}

    /**
     * Create an analyzer for a bundled Minecraft version.
     *
     * @param version - Minecraft version key, such as `1.21` or `1.21.11`.
     * @param options - Optional construction settings. Pass `mutations` here
     * to derive a custom registry from the bundled vanilla data.
     * @returns A reusable analyzer bound to the resolved registry and mechanics.
     *
     * @throws If the requested version or mutations cannot produce a valid registry.
     */
    public static forVersion(version: string, options: AnalyzerOptions = {}): EnchantingAnalyzer {
        if (options.mutations !== undefined) {
            return this.withMutations(version, options.mutations);
        }
        return new EnchantingAnalyzer(EngineFactory.createForVersion(version));
    }

    /**
     * Create an analyzer from bundled vanilla data plus registry mutations.
     *
     * @param version - Base Minecraft version to load before applying mutations.
     * @param mutations - One mutation or an ordered list of mutations. Later
     * mutations see the result of earlier ones.
     * @returns A reusable analyzer whose registry source is marked as `mutated`.
     *
     * @remarks
     * This is the explicit form of `forVersion(version, { mutations })`.
     *
     * @throws If a mutation references unknown data or leaves the registry invalid.
     */
    public static withMutations(
        version: string,
        mutations: RegistryMutation | RegistryMutation[]
    ): EnchantingAnalyzer {
        const registry = RegistryFactory.buildWithMutations(
            version,
            mutations
        );
        return new EnchantingAnalyzer(EngineFactory.create(registry));
    }

    /**
     * High-level registry metadata for this analyzer.
     *
     * @remarks
     * This intentionally exposes metadata only. The mutable registry tables and
     * packed lookup structures remain internal so package callers do not depend
     * on engine implementation details.
     */
    public get registry(): AnalyzerRegistryInfo {
        const registry = this.engine.registry;
        return {
            version: registry.version,
            source: registry.source,
            mechanics: registry.mechanics,
            multiEnchantBooks: registry.multiEnchantBooks
        };
    }

    /**
     * Clear caches owned by this analyzer instance.
     *
     * @remarks
     * Use this when benchmarking, profiling cache behavior, or releasing memory
     * after a burst of searches. It does not change the registry or invalidate
     * the analyzer itself.
     */
    public resetCaches(): void {
        this.engine.resetCaches();
    }

    /**
     * Return high-level cache hit/miss counters for this analyzer instance.
     *
     * @returns Cache counters for modified-level distributions and enchantment pools.
     */
    public getCacheMetrics(): AnalyzerCacheMetrics {
        return this.engine.getCacheMetrics();
    }

    /**
     * Run a search and return compact machine-readable probabilities.
     *
     * @param request - Enchanting setup, optional clue, and optional search controls.
     * @returns Raw `EnchantStats` using numeric enchantment IDs, packed rank IDs,
     * and packed combo keys.
     *
     * @remarks
     * This is the best method for scripts that want stable JSON or advanced
     * callers that do their own post-processing. Use `insights` when displaying
     * results to humans, or pass the returned stats to `humanize` later.
     *
     * @throws If the item, material, XP level, clue, or search controls are invalid
     * for this analyzer's registry.
     */
    public async stats(request: AnalyzerRequest): Promise<EnchantStats> {
        return this.engine.getStats(this.toEngineRequest(request));
    }

    /**
     * Run a search and return display-ready probabilities.
     *
     * @param request - Enchanting setup, optional clue, and optional search controls.
     * @param sortMode - Combo ordering for the human-readable `combos` map.
     * Defaults to probability order.
     * @returns `EnchantInsights` with enchantment names, rank labels, combo labels,
     * and the same accounting totals exposed by `stats`.
     *
     * @remarks
     * This is the default choice for application views, CLIs, and reports.
     */
    public async insights(request: AnalyzerRequest, sortMode: ResultSortMode = 'prob'): Promise<EnchantInsights> {
        const stats = await this.stats(request);
        return this.humanize(stats, sortMode);
    }

    /**
     * Convert raw stats from this analyzer into human-readable names.
     *
     * @param stats - Raw stats returned by `stats` from the same analyzer version
     * and registry shape.
     * @param sortMode - Combo ordering for the human-readable `combos` map.
     * Defaults to probability order.
     * @returns Human-readable `EnchantInsights` without running another search.
     *
     * @remarks
     * Packed enchantment IDs are registry-local. Do not pass stats produced by a
     * different Minecraft version or a differently mutated analyzer; labels may
     * decode incorrectly.
     */
    public humanize(stats: EnchantStats, sortMode: ResultSortMode = 'prob'): EnchantInsights {
        return HumanizationService.humanize(stats, this.engine.registry, sortMode, this.engine.registry.romanMap);
    }

    private toEngineRequest(request: AnalyzerRequest): CheckpointSearchRequest {
        return {
            item: request.item,
            material: request.material,
            xp: request.xp,
            clue: request.clue,
            ...this.resolveSearch(request.search, request.item === 'book'),
            signal: request.signal,
            onProgress: request.onProgress,
            summaryLimit: request.summaryLimit,
            uncappedResults: request.uncappedResults,
            timing: request.timing,
            instrumentation: request.instrumentation
        };
    }

    private resolveSearch(search: AnalyzerSearchMode | undefined, isBook: boolean): AnalyzerSearchControls {
        if (search === undefined) return {};
        if (typeof search === 'string') return this.controlsForPreset(search, isBook);

        const { preset, ...overrides } = search;
        return {
            ...(preset === undefined ? {} : this.controlsForPreset(preset, isBook)),
            ...overrides
        };
    }

    private controlsForPreset(preset: AnalyzerSearchPreset, isBook: boolean): AnalyzerSearchControls {
        if (preset === 'exhaustive') return { exhaustive: true };

        const checkpoint = getSearchCheckpointForRefinement(preset, isBook);
        return {
            threshold: checkpoint.threshold,
            maxIterations: checkpoint.limit,
            ...(checkpoint.targetClassifiedMass === undefined
                ? {}
                : { targetClassifiedMass: checkpoint.targetClassifiedMass })
        };
    }
}
