/**
 * Detailed breakdown of probability mass categories for accuracy and diagnostic reporting.
 * All values are percentages (0.0 to 1.0).
 */
export interface MassAccountingBreakdown {
  /** Nodes that explicitly reached a leaf state and contribute to reported result combos. */
  resolved: number;
  /** Nodes proven incompatible with the observed clue during clue-aware searches. */
  clueIncompatible: number;
  /** Nodes still in the queue (limited by threshold/iterations). Matches UI Uncertainty. */
  pending: number;
  /** Nodes that were discarded because they fell below the SYSTEM_THRESHOLD_FLOOR. */
  sieved: number;
  /** Nodes discarded because they exceeded technical limits (e.g. 6-enchant cap). */
  overflow: number;
  /** Nodes discarded because they hit engine search/storage limits. */
  capped: number;
  /** Cumulative mass lost to floating point precision or integer division during search. */
  rounding: number;
  /** Diagnostic: Gross mass made distributable only because carried residue combined with later input. (Non-additive.) */
  recoveredRounding: number;
  /** Diagnostic: Mass recovered from sieved branches via aggregation. (Non-additive) */
  recoveredSieved: number;
  /** Diagnostic: Precise mass counts as strings to preserve BigInt precision in JSON. */
  units?: { [K in keyof MassBucketUnits]: string };
}

/**
 * High-precision BigInt representation of conserved probability mass buckets.
 */
export interface MassBucketUnits {
    resolved: bigint;
    clueIncompatible: bigint;
    pending: bigint;
    sieved: bigint;
    overflow: bigint;
    capped: bigint;
    rounding: bigint;
    recoveredRounding: bigint;
    recoveredSieved: bigint;
}

export type MassBucketName = keyof MassBucketUnits;

export interface MassAccountingPhases {
    /** Engine/search-stage accounting. */
    engine: MassAccountingBreakdown;
    /** Optional projection/materialization-stage accounting. */
    projection?: ProjectionAccountingBreakdown | undefined;
}

/**
 * Projection-layer probability mass categories.
 *
 * These buckets describe compatibility-view materialization after search has produced
 * engine results. They intentionally have a separate invariant from engine mass:
 * `source = projected + clueIncompatible + loss`.
 */
export interface ProjectionAccountingBreakdown {
    /** Mass entering this projection stage, usually engine resolved mass. */
    source: number;
    /** Mass emitted as projected concrete result rows. */
    projected: number;
    /** Projection-stage mass that cannot show the requested clue. */
    clueIncompatible: number;
    /** Projection-stage mass lost to integer materialization/reduction. */
    loss: number;
    /** Precise mass counts as strings to preserve BigInt precision in JSON. */
    units?: ProjectionBucketUnits | undefined;
}

export interface ProjectionBucketUnits {
    source: string;
    projected: string;
    clueIncompatible: string;
    loss: string;
}
