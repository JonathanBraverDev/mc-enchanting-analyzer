import { ENGINE_LIMITS } from '#constants/engine.js';

/**
 * Standard values used for validation, snapshots, and high-precision testing.
 */
export const TEST_DEFAULTS = {
    /** High-precision threshold for snapshot parity (1e-8). */
    SNAPSHOT_THRESHOLD: 0.00000001,

    /** Max iterations for snapshot generation to ensure full convergence. */
    SNAPSHOT_ITERATIONS: ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED,

    /** Results limit for snapshot generation to capture the full distribution tail. */
    SNAPSHOT_RESULTS_LIMIT: ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,

    /** Floating-point epsilon for statistical assertions. */
    EPSILON_COMPARISON: 1e-12,

    /** Stricter epsilon for mass accounting (bit-perfect parity). */
    EPSILON_ACCOUNTING: 1e-15
};
