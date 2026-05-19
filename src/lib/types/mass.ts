/**
 * Detailed breakdown of probability mass categories for accuracy and diagnostic reporting.
 * All values are percentages (0.0 to 1.0).
 */
export interface MassAccountingBreakdown {
  /** Nodes that explicitly reached a leaf state and contribute to reported result combos. */
  resolved: number;
  /** Nodes proven incompatible with the observed clue during clue-aware searches. */
  clueIncompatible: number;
  /** Projected compatibility-view mass represented by concrete result rows after projection. */
  projected?: number | undefined;
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
  /** Mass that reached the projection stage but could not be represented in projected concrete result rows. */
  projectionLoss?: number | undefined;
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
    projected?: bigint | undefined;
    pending: bigint;
    sieved: bigint;
    overflow: bigint;
    capped: bigint;
    rounding: bigint;
    projectionLoss?: bigint | undefined;
    recoveredRounding: bigint;
    recoveredSieved: bigint;
}

export type MassBucketName = Exclude<keyof MassBucketUnits, 'projected'>;
