/**
 * Detailed breakdown of probability mass categories for accuracy and diagnostic reporting.
 * All values are percentages (0.0 to 1.0).
 */
export interface MassAccounting {
  /** Nodes that explicitly reached a leaf state (game rules). Matches UI Accuracy. */
  resolved: number;
  /** Nodes still in the queue (limited by threshold/iterations). Matches UI Uncertainty. */
  pending: number;
  /** Nodes that were discarded because they fell below the SYSTEM_THRESHOLD_FLOOR. */
  sieved: number;
  /** Nodes discarded because they exceeded technical limits (e.g. 6-enchant cap). */
  overflow: number;
  /** Nodes discarded because they hit engine search/storage limits. */
  capped: number;
  /** Cumulative mass lost to floating point precision or integer division. */
  rounding: number;
  /** Diagnostic: Mass recovered from the rounding bucket via residual promotion. (Non-additive) */
  recoveredRounding: number;
  /** Diagnostic: Mass recovered from sieved branches via aggregation. (Non-additive) */
  recoveredSieved: number;
  /** Diagnostic: Precise mass counts as strings to preserve BigInt precision in JSON. */
  units?: { [K in keyof MassBookkeeping]: string };
}

/**
 * High-precision BigInt representation of probability mass buckets (using 1e12 as 1.0).
 */
export interface MassBookkeeping {
    resolved: bigint;
    pending: bigint;
    sieved: bigint;
    overflow: bigint;
    capped: bigint;
    rounding: bigint;
    recoveredRounding: bigint;
    recoveredSieved: bigint;
}
