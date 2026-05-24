/**
 * Supported package entry point for application and tool callers.
 *
 * @packageDocumentation
 */
import { EngineFactory as RuntimeEngineFactory } from '#engine/factory.js';
import { RegistryFactory as RuntimeRegistryFactory } from '#core/factory.js';

import type {
    BuiltRegistryState as RuntimeBuiltRegistryState,
    ItemSelectionRequest,
    LevelDistribution,
    ProgressUpdate,
    RegistryMutation,
    SearchTiming
} from '#types/index.js';
import type { MassAccountingBreakdown } from '#types/mass.js';
import type { VersionMechanics } from '#types/domain.js';

export type {
    ConflictRule,
    ConflictRuleSelector,
    EnchantableItemRule,
    EnchantableItemRuleSelector,
    EnchantabilityTable,
    Enchantment,
    EnchantmentGroupRule,
    EnchantmentGroupRuleSelector,
    EnchantmentLevels,
    ItemSelectionRequest,
    LevelDistribution,
    MaterialRule,
    MaterialRuleSelector,
    ProgressUpdate,
    RegistryMutation,
    SearchTiming,
    VersionMechanics
} from '#types/index.js';
export type {
    MassAccountingBreakdown,
    MassAccountingDetailBucket,
    MassAccountingDetails,
    MassAccountingOperationDetails,
    MassAccountingStageDetails,
    MassBucketName,
    MassBucketUnits
} from '#types/index.js';

/**
 * Supported registry handle returned by `RegistryFactory`.
 *
 * The runtime registry contains packed lookup tables and caches that are not
 * part of the package API. Treat this value as a handle for constructing
 * engines and inspecting high-level version metadata.
 *
 * @public
 */
export interface RegistryState {
    /** Minecraft version resolved by the registry factory. */
    readonly version: string;
    /** Whether this registry was bundled vanilla data or mutation-derived data. */
    readonly source: 'vanilla' | 'mutated';
    /** High-level mechanics flags for this version. */
    readonly mechanics: VersionMechanics;
    /** Whether this version can generate multiple enchantments on books. */
    readonly multiEnchantBooks: boolean;
}

/**
 * Supported vanilla registry handle.
 *
 * @public
 */
export interface VanillaRegistryState extends RegistryState {
    readonly source: 'vanilla';
}

/**
 * Supported mutated registry handle.
 *
 * @public
 */
export interface MutatedRegistryState extends RegistryState {
    readonly source: 'mutated';
    /** Mutations used to build this registry. */
    readonly mutations: readonly RegistryMutation[];
}

/**
 * Supported registry handle accepted by `EngineFactory.create`.
 *
 * @public
 */
export type BuiltRegistryState = VanillaRegistryState | MutatedRegistryState;

/**
 * Public stats request accepted by `EnchantEngine.getStats`.
 *
 * This is the stable caller-facing request shape. Lower-level checkpoint
 * controls and engine-runtime diagnostics stay inside the repository runtime.
 *
 * @public
 */
export interface EnchantStatsRequest extends ItemSelectionRequest {
    /** Player XP level used by the enchanting-table roll. */
    xp: number;
    /** Optional exact displayed table clue, such as `Sharpness III`. */
    clue?: string | null | undefined;
    /** Stop when the largest pending node mass falls below this value. */
    threshold?: number | bigint | undefined;
    /** Stop once resolved or otherwise classified mass reaches this target. */
    targetClassifiedMass?: number | bigint | undefined;
    /** Maximum graph-node expansions to perform before returning summarized stats. */
    maxIterations?: number | undefined;
    /** Optional abort signal for long-running searches. */
    signal?: AbortSignal | undefined;
    /** Optional progress callback for host UIs. */
    onProgress?: ((update: ProgressUpdate) => void) | undefined;
    /** Maximum number of combo rows to include in summarized presentation output. */
    summaryLimit?: number | undefined;
    /** Explicitly allow summarized presentation output to include every combo row. */
    uncappedResults?: boolean | undefined;
    /** Optional timing accumulator for diagnostics and profiling tools. */
    timing?: SearchTiming | undefined;
}

/**
 * Presented enchant stats from the search engine.
 *
 * @public
 */
export interface EnchantStats {
    /** Map of enchantment rank IDs to their total cumulative probability. Key is `(enchantId << 8 | rank)`. */
    ranks: { [idAndRank: number]: number };
    /** Map of base enchantment IDs to their total probability on the item at any rank. */
    any: { [id: number]: number };
    /** Map of enchantment counts to their total probability. */
    count: { [count: number]: number };
    /** Map of bit-packed hexadecimal combo strings to their joint probability. */
    combos: { [packed: string]: number };
    /** Map of displayed-clue rank IDs to their total probability. Omitted for clue-conditioned stats. */
    shownClueDistribution?: { [idAndRank: number]: number } | undefined;
    /** Minimum probability threshold used for this search. */
    threshold: number;
    /** Normalized classified mass represented by the summary. */
    accuracy: number;
    /** Probability-mass accounting buckets for this search. */
    accounting: MassAccountingBreakdown;
    /** Observed displayed-clue diagnostics. Present only for clue-conditioned stats. */
    clue?: {
        /** Observed clue enchantment/rank ID, encoded as `(enchantId << 8 | rank)`. */
        idAndRank: number;
        /** Absolute displayed-clue mass used for Bayesian conditioning. */
        knownSpace: number;
    } | undefined;
    /** Optional timing measurements when requested by the caller. */
    timing?: SearchTiming | undefined;
}

/**
 * Public engine contract returned by `EngineFactory`.
 *
 * @public
 */
export interface EnchantEngine {
    /** Resolved registry used by this engine. */
    readonly registry: BuiltRegistryState;
    /** Clear engine-owned caches. */
    resetCaches(): void;
    /** Return high-level cache hit/miss counters. */
    getCacheMetrics(): {
        distCache: { hits: number; misses: number };
        poolCache: { hits: number; misses: number };
    };
    /** Release engine-owned resources. */
    destroy(): void;
    /** Inspect the modified-level probability distribution for an XP/enchantability pair. */
    getModifiedLevelDist(xp: number, enchantability: number): LevelDistribution;
    /** Inspect eligible packed enchantments for an item, level, and optional conflict bitset. */
    getAvailablePool(item: string, level: number, bitset?: bigint): number[];
    /** Return summarized probabilities for product and tool callers. */
    getStats(request: EnchantStatsRequest): Promise<EnchantStats>;
}

/**
 * Public engine factory.
 *
 * @public
 */
export class EngineFactory {
    /** Create an engine from a bundled vanilla version. */
    public static createForVersion(version: string): EnchantEngine {
        return RuntimeEngineFactory.createForVersion(version);
    }

    /** Create an engine from a resolved registry, including mutated registries. */
    public static create(registry: BuiltRegistryState): EnchantEngine {
        return RuntimeEngineFactory.create(registry as RuntimeBuiltRegistryState);
    }

    /** Clear shared engine-level caches. */
    public static clearCaches(): void {
        RuntimeEngineFactory.clearCaches();
    }
}

/**
 * Public registry factory.
 *
 * @public
 */
export class RegistryFactory {
    /** Build a bundled vanilla registry handle. */
    public static build(version: string): VanillaRegistryState {
        return RuntimeRegistryFactory.build(version);
    }

    /** Build a mutation-derived registry handle. */
    public static buildWithMutations(version: string, mutations: RegistryMutation | RegistryMutation[]): MutatedRegistryState {
        return RuntimeRegistryFactory.buildWithMutations(version, mutations);
    }
}
