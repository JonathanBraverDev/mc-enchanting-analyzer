import { RegistryFactory } from '#core/factory.js';
import { getSearchCheckpointForRefinement } from '#core/config.js';
import { EngineFactory } from '#engine/factory.js';
import { HumanizationService } from '#services/HumanizationService.js';
import type {
    CheckpointSearchRequest,
    EnchantStats
} from '#types/index.js';
import type { EnchantEngine } from '#engine/index.js';
import type { RegistryMutation, VersionMechanics } from '../types/domain.js';
import type { MassAccountingBreakdown } from '../types/mass.js';

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
    /** Reuse compatible cached search state from earlier calls on the same backing engine. */
    useCache?: boolean | undefined;
}

/**
 * Search mode accepted by {@link EnchantingAnalyzer.analyze} and
 * {@link EnchantingAnalyzer.analyzeRaw}.
 *
 * @remarks
 * Pass a string for a common preset, or pass an object when a caller needs to
 * override specific search controls.
 *
 * @public
 */
export type AnalyzerSearchMode = AnalyzerSearchPreset | AnalyzerSearchControls;

/**
 * Combo ordering modes for human-readable analyzer output.
 *
 * @public
 */
export type AnalyzerSortMode = 'prob' | 'count' | 'rank';

/**
 * Lightweight progress update reported while an analyzer request is running.
 *
 * @public
 */
export interface AnalyzerProgressUpdate {
    /** Number of modified levels or search units processed. */
    processed: number;
    /** Total modified levels or search units expected for this phase. */
    total: number;
    /** Optional current resolved/classified mass from `0` to `1`. */
    accuracy?: number | undefined;
}

/**
 * Human-readable result returned by {@link EnchantingAnalyzer.analyze} and
 * {@link EnchantingAnalyzer.humanize}.
 *
 * @remarks
 * Map keys are display labels such as `Efficiency IV`, `Fortune`, or
 * `Efficiency IV+Fortune III`. Use {@link AnalyzerRawResult} when a caller
 * needs compact registry-local IDs instead of presentation labels.
 *
 * @public
 */
export interface AnalyzerResult {
    /** Map of enchantment rank labels to their total cumulative probability. */
    ranks: Record<string, number>;
    /** Map of base enchantment labels to their total probability on the item at any rank. */
    any: Record<string, number>;
    /** Map of enchantment counts to their total probability. */
    count: Record<number, number>;
    /** Map of human-readable combo labels to their joint probability. */
    combos: Record<string, number>;
    /** Reliability of the result as resolved/classified mass from `0` to `1`. */
    accuracy: number;
    /** Probability mass accounting for this checkpoint result. */
    accounting: MassAccountingBreakdown;
    /** Observed displayed-clue diagnostics. Present only for clue-conditioned stats. */
    clue?: {
        /** Human-readable observed clue name, including rank. */
        name: string;
        /** Absolute displayed-clue mass used for Bayesian conditioning. */
        knownSpace: number;
    } | undefined;
    /** Possible shown table clues and their original unconditioned probabilities. */
    shownClueDistribution?: Record<string, number> | undefined;
}

/**
 * Input shared by human-readable and raw analyzer calls.
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
    onProgress?: ((update: AnalyzerProgressUpdate) => void) | undefined;
    /** Maximum number of combo rows to include; use `0` to omit combo rows. */
    summaryLimit?: number | undefined;
    /** Allow combo output above the normal safety cap, including every combo when no limit is set. */
    uncappedResults?: boolean | undefined;
}

/**
 * Compact machine-readable result returned by {@link EnchantingAnalyzer.analyzeRaw}.
 *
 * @remarks
 * Keys are registry-local numeric IDs and packed combo strings intended for
 * scripts, storage, and callers that provide their own presentation layer. Use
 * {@link EnchantingAnalyzer.analyze} for display-ready enchantment names.
 *
 * @public
 */
export interface AnalyzerRawResult {
    /** Map of enchantment rank IDs to their total cumulative probability. Key is `(enchantId << 8 | rank)`. */
    ranks: { [idAndRank: number]: number };
    /** Map of base enchantment IDs to their total probability on the item at any rank. */
    any: { [id: number]: number };
    /** Map of enchantment counts to their total probability. */
    count: { [count: number]: number };
    /** Map of bit-packed hexadecimal combo strings to their joint probability. */
    combos: { [packed: string]: number };
    /** Map of rank IDs to their probability of being the shown table clue. Omitted for clue-conditioned stats. */
    shownClueDistribution?: { [idAndRank: number]: number } | undefined;
    /** Minimum probability threshold used by the search. */
    threshold: number;
    /** Normalized classified mass, including resolved results and exact clue-incompatible mass. */
    accuracy: number;
    /** Probability mass accounting for this checkpoint result. */
    accounting: MassAccountingBreakdown;
    /** Observed displayed-clue diagnostics. Present only for clue-conditioned stats. */
    clue?: {
        /** Observed clue enchantment/rank ID encoded as `(enchantId << 8 | rank)`. */
        idAndRank: number;
        /** Absolute displayed-clue mass used for Bayesian conditioning. */
        knownSpace: number;
    } | undefined;
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
 * Hit/miss counters for one backing engine cache.
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
 * `analyze` returns display-ready enchantment names and combo labels for
 * applications, CLIs, and reports. `analyzeRaw` returns the same probabilities
 * as compact registry-local IDs and packed combo keys for storage, scripts, or
 * advanced processing. All returned probabilities are fractions from `0` to
 * `1`.
 *
 * Vanilla analyzers for the same requested version string share a backing
 * engine and cache. Mutation-derived analyzers have their own backing engine.
 * Keep an analyzer instance around when issuing related searches so compatible
 * cached search state can be reused.
 *
 * @example
 * ```ts
 * import { EnchantingAnalyzer } from 'mc-enchanting-analyzer';
 *
 * const analyzer = EnchantingAnalyzer.forVersion('1.21');
 * const result = await analyzer.analyze({
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
     * Clear caches owned by this analyzer's backing engine.
     *
     * @remarks
     * Vanilla analyzers created with `forVersion()` for the same resolved
     * version share a backing engine, so resetting one also resets cache state
     * observed by the others. Mutation-derived analyzers use isolated backing
     * engines. This does not change the registry or invalidate the analyzer.
     */
    public resetCaches(): void {
        this.engine.resetCaches();
    }

    /**
     * Return high-level cache hit/miss counters for this analyzer's backing engine.
     *
     * @returns Cache counters for modified-level distributions and enchantment pools.
     */
    public getCacheMetrics(): AnalyzerCacheMetrics {
        return this.engine.getCacheMetrics();
    }

    /**
     * Run a search and return display-ready probabilities.
     *
     * @param request - Enchanting setup, optional clue, and optional search controls.
     * @param sortMode - Combo ordering for the human-readable `combos` map.
     * Defaults to probability order.
     * @returns `AnalyzerResult` with enchantment names, rank labels, combo labels,
     * and accounting totals.
     *
     * @remarks
     * This is the default choice for application views, CLIs, and reports.
     * Use `analyzeRaw` for compact registry-local IDs and packed combo keys.
     *
     * @throws If the item, material, XP level, clue, or search controls are invalid
     * for this analyzer's registry.
     */
    public async analyze(request: AnalyzerRequest, sortMode: AnalyzerSortMode = 'prob'): Promise<AnalyzerResult> {
        const stats = await this.analyzeRaw(request);
        return this.humanize(stats, sortMode);
    }

    /**
     * Run a search and return compact machine-readable probabilities.
     *
     * @param request - Enchanting setup, optional clue, and optional search controls.
     * @returns Raw analysis result using numeric enchantment IDs, packed rank IDs, and
     * packed combo keys.
     *
     * @remarks
     * This is the best method for scripts that want stable JSON or advanced
     * callers that do their own post-processing. Use `analyze` when displaying
     * results to humans, or pass the returned result to `humanize` later.
     *
     * @throws If the item, material, XP level, clue, or search controls are invalid
     * for this analyzer's registry.
     */
    public async analyzeRaw(request: AnalyzerRequest): Promise<AnalyzerRawResult> {
        return stripDiagnostics(await this.engine.getStats(this.toEngineRequest(request)));
    }

    /**
     * Convert a raw analysis result from this analyzer into human-readable names.
     *
     * @param stats - Raw result returned by `analyzeRaw` from the same analyzer version
     * and registry shape.
     * @param sortMode - Combo ordering for the human-readable `combos` map.
     * Defaults to probability order.
     * @returns Human-readable `AnalyzerResult` without running another search.
     *
     * @remarks
     * Packed enchantment IDs are registry-local. Do not pass stats produced by a
     * different Minecraft version or a differently mutated analyzer; labels may
     * decode incorrectly.
     */
    public humanize(stats: AnalyzerRawResult, sortMode: AnalyzerSortMode = 'prob'): AnalyzerResult {
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
            uncappedResults: request.uncappedResults
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

function stripDiagnostics(stats: EnchantStats): AnalyzerRawResult {
    return {
        ranks: stats.ranks,
        any: stats.any,
        count: stats.count,
        combos: stats.combos,
        threshold: stats.threshold,
        accuracy: stats.accuracy,
        accounting: stats.accounting,
        ...(stats.shownClueDistribution === undefined
            ? {}
            : { shownClueDistribution: stats.shownClueDistribution }),
        ...(stats.clue === undefined ? {} : { clue: stats.clue })
    };
}
