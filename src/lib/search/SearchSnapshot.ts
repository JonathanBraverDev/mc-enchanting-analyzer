import { MassAccountingBreakdown } from '#types/mass.js';
import { PackedCombo } from '#types/index.js';

/**
 * Pending graph-node mass exported for presentation projections and diagnostics.
 *
 * @public
 */
export interface PendingFrontierEntry {
    readonly graphId: number;
    readonly nodeId: number;
    readonly mass: bigint;
    readonly combo: PackedCombo;
    readonly count: number;
}

/**
 * Aggregate combo/frontier contribution harvested without materializing public row factors.
 *
 * @public
 */
export interface ComboMassAggregates {
    readonly any: readonly bigint[];
    readonly ranks: readonly bigint[];
    readonly count: readonly bigint[];
    readonly shownClueDistribution: ReadonlyMap<number, bigint>;
}

/**
 * Aggregate pending-frontier contribution harvested without materializing public row factors.
 *
 * @public
 */
export interface PendingFrontierAggregates extends ComboMassAggregates {
    readonly clueJoint?: PendingClueJointAggregates | undefined;
}

/**
 * Unnormalized pending aggregate mass that is already joint with one observed table clue.
 *
 * @public
 */
export interface PendingClueJointAggregates {
    readonly targetClueId: number;
    readonly knownSpace: bigint;
    readonly any: readonly bigint[];
    readonly ranks: readonly bigint[];
    readonly count: readonly bigint[];
}

/** @public */
export interface FactorizedFrontierEntry {
    readonly graphId: number;
    readonly nodeId: number;
    readonly programId: number;
    readonly mass: bigint;
    readonly count: number;
    readonly nodeKind: 'solid' | 'plex';
    readonly targetClueReachable?: boolean | undefined;
}

/** @public */
export const ENGINE_FRONTIER_KIND = {
    EMPTY: 'empty',
    MATERIALIZED: 'materialized',
    FACTORIZED: 'factorized'
} as const;

/** @public */
export type EngineFrontierKind = 'empty' | 'materialized' | 'factorized';

/** @public */
export interface EmptyEngineFrontier {
    readonly kind: 'empty';
}

/** @public */
export interface MaterializedEngineFrontier {
    readonly kind: 'materialized';
    readonly entries: readonly PendingFrontierEntry[];
}

/** @public */
export interface FactorizedEngineFrontier {
    readonly kind: 'factorized';
    readonly entries: readonly FactorizedFrontierEntry[];
    readonly summary: PendingFrontierAggregates;
}

/** @public */
export type EngineFrontierView = EmptyEngineFrontier | MaterializedEngineFrontier | FactorizedEngineFrontier;

/** @public */
export interface EngineSearchSnapshot {
    readonly results: ReadonlyMap<PackedCombo, bigint>;
    /** Exact resolved aggregate buckets for engines that can expose stats without combo rows. */
    readonly resolvedAggregates?: ComboMassAggregates | undefined;
    readonly mass: MassAccountingBreakdown;
    readonly iterations: number;
    /** Mass of the most recently expanded frontier node. Useful for checkpoint overshoot diagnostics. */
    readonly lastExpandedMass: bigint;
    readonly pendingCount: number;
    readonly largestPendingMass: bigint;
    /**
     * Compatibility materialized pending rows. The canonical V8 path normally exposes
     * factorized pending summaries; materialized rows remain for diagnostics and
     * consumers that explicitly need expanded frontier entries.
     */
    readonly pendingEntries: readonly PendingFrontierEntry[];
    /**
     * Compatibility pending summary for factorized engines. Prefer `frontier` for new code so
     * consumers can distinguish native frontier shape explicitly.
     */
    readonly pendingAggregates?: PendingFrontierAggregates | undefined;
    readonly frontier: EngineFrontierView;
    readonly graphCount: number;
    readonly seededLevelCount: number;
    readonly activeResidueCount: number;
    readonly activeResidueMass: bigint;
    readonly fullyResolved: boolean;
    readonly suffixMerging: SearchSuffixMergeDiagnostics;
}

/**
 * Explicit materialized snapshot of an expanded frontier. Expensive for large frontiers.
 *
 * @internal
 */
export interface SearchRunSnapshot extends EngineSearchSnapshot {
    readonly pendingEntries: readonly PendingFrontierEntry[];
    readonly pendingAggregates?: undefined;
    readonly frontier: EmptyEngineFrontier | MaterializedEngineFrontier;
}

/** @public */
export interface SearchSuffixMergeDiagnostics {
    readonly enabled: boolean;
    readonly canonicalEntryCount: number;
    readonly hits: number;
    readonly misses: number;
    readonly mergedPendingMass: bigint;
    readonly avoidedPendingEntries: number;
}

/** @internal */
export function createEmptyEngineFrontier(): EmptyEngineFrontier {
    return Object.freeze({ kind: ENGINE_FRONTIER_KIND.EMPTY });
}

/** @internal */
export function createMaterializedEngineFrontier(entries: readonly PendingFrontierEntry[]): EmptyEngineFrontier | MaterializedEngineFrontier {
    if (entries.length === 0) return createEmptyEngineFrontier();
    return Object.freeze({
        kind: ENGINE_FRONTIER_KIND.MATERIALIZED,
        entries
    });
}

/** @internal */
export function createFactorizedEngineFrontier(
    entries: readonly FactorizedFrontierEntry[],
    summary: PendingFrontierAggregates,
    pendingCount = entries.length
): EmptyEngineFrontier | FactorizedEngineFrontier {
    if (pendingCount === 0) return createEmptyEngineFrontier();
    return Object.freeze({
        kind: ENGINE_FRONTIER_KIND.FACTORIZED,
        entries,
        summary
    });
}

/** @internal */
export function getMaterializedFrontierEntries(frontier: EngineFrontierView): readonly PendingFrontierEntry[] {
    return frontier.kind === ENGINE_FRONTIER_KIND.MATERIALIZED ? frontier.entries : [];
}
