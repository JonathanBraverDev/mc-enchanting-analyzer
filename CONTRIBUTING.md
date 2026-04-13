# Contributing to Minecraft Enchantment Analyzer

Thank you for your interest in contributing! This document provides guidelines for development, testing, and performance profiling.

## Development Principles

1.  **Strict Mass Conservation**: Every probability mass must be accounted for. Use `ProbabilityMassTracker` for all search logic.
2.  **Version Isolation**: Use the `registry.version` when interacting with `CacheManager`. Never share caches between game versions.
3.  **BigInt for Math**: Use high-precision `bigint` (scaled to `10^12`) for all core probability calculations. Only convert to `number` in the final `SummaryService`.
4.  **Deterministic Results**: All engine logic must be deterministic. Avoid `Math.random()` or platform-specific floating point dependencies in the core.

## Testing Guidelines

### Unit & Integration Tests
Run the main test suite using:
```bash
npm test
```
- **Snapshots**: We use snapshot testing for engine output. If you make changes that intentionally alter the math, you must update the snapshots and explain the delta.
- **Error Paths**: Ensure all new registry or engine parameters are validated and throw descriptive errors.

### Regression Verification
Before submitting any major engine refactor, run the snapshot regression suite to ensure zero unintended mathematical drift.

## Performance Profiling

Performance is critical for the "Standalone HTML" version. We use a dedicated profiling script to track execution time and cache efficiency.

### Running the Profiler
```bash
npx tsx src/tests/profiler.ts
```

This script will:
1. Initialize the engine for a specific version.
2. Run a set of standard search queries (Book vs. Item).
3. Report:
    - **Time per query** (ms).
    - **Cache hit rates** (via `cacheManager.getMetrics()`).
    - **Memory footprint** (if available).

### Optimizing the Search
- Use `SearchProcessor` for low-level loops.
- Avoid object allocation in the hot loops (`processInitialNode`, `processSearchNode`).
- Leverage bit-packing for keys and state.

## Mass Conservation Invariants

The engine maintains a system of "buckets" to track every atom of probability:
- **Resolved**: Reached a terminal enchantment combo.
- **Pending**: Remaining in the frontier (incomplete search).
- **Sieved**: Pruned because probability fell below `ENGINE_DEFAULTS.MIN_RESOLVE_THRESHOLD`.
- **Capped**: Pruned because result limit or heap size was reached.
- **Overflow**: Discarded by engine limits (6+ enchants).
- **Rounding**: Compensation for fixed-point math adjustments.

**Invariant**: `Resolved + Pending + Sieved + Capped + Overflow + Rounding === 10^12` (PRECISION)

## Directory Structure

- `src/core/`: Registry construction and static game rules.
- `src/engine/`: Core search pipeline and probability math.
- `src/services/`: Caching, serialization, and post-processing.
- `src/utils/`: Generic math and data structure helpers.
- `src/types/`: Branded types and domain interfaces.
