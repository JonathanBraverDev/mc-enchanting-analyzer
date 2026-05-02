# Contributing to Minecraft Enchantment Analyzer

Thank you for your interest in contributing! This document provides guidelines for development, testing, and performance profiling.

## Workflow & Branching Strategy

We follow a specialized workflow to ensure a clean production history while maintaining granular development context.

1.  **Development (`dev`)**: All active development happens here or on feature branches merged into `dev`.
    *   Every PR to `dev` must pass the full test suite and security scan.
2.  **Releases (`release/vX.Y.Z`)**: When preparing for a release, create a branch from `dev`.
    *   Update the `CHANGELOG.md` on this branch.
    *   For major releases, update `ARCHITECTURE.md` and at least one other top-level project doc (`README.md`, `MASS_HANDLING.md`, or `CONTRIBUTING.md`).
    *   For minor releases, update project docs when behavior, architecture, workflows, or user-facing capabilities changed.
    *   Patch releases are exempt from release documentation checks unless the patch changes documented behavior.
    *   PR the release branch into `main`.
3.  **Production (`main`)**: This branch contains ONLY milestone commits.
    *   Releases are merged into `main` using **Squash and Merge**.
    *   Upon merge, `main` is automatically rebased back into `dev` to keep them synchronized.

## Development Principles

1.  **Strict Mass Conservation**: Every probability mass must be accounted for. Use `ProbabilityMassBookkeeper` for all search logic.
2.  **Version Isolation**: Use the `registry.version` when interacting with `CacheManager`. Never share caches between game versions.
3.  **BigInt for Math**: Use high-precision `bigint` (scaled to `10^12`) for all core probability calculations. Only convert to `number` in the final `SummaryService`.
4.  **Deterministic Results**: All engine logic must be deterministic. Avoid `Math.random()` or platform-specific floating point dependencies in the core.
5.  **Subpath Imports**: Use `#` aliases for all internal library imports. Avoid direct relative paths (`../`, `./`) when an alias is available.

## Linting & Style

We use TypeScript for type safety and a custom script to enforce import consistency.
- **Type Checking**: `npm run lint`
- **Import Optimization**: `npm run lint:imports`

Ensure both pass before submitting changes.

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

Performance is critical for the "Standalone HTML" version. We use a dedicated benchmarking script to track execution time and cache efficiency.

### Running the Benchmarks
```bash
npx tsx scripts/benchmark_engine.ts
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
- **Sieved**: Pruned because probability fell below `ENGINE.MIN_RESOLVE_THRESHOLD`.
- **Capped**: Pruned because result limit or heap size was reached.
- **Overflow**: Discarded by engine limits (6+ enchants).
- **Rounding**: Compensation for fixed-point math adjustments.

**Invariant**: `Resolved + Pending + Sieved + Capped + Overflow + Rounding === 10^12` (PRECISION)

## Directory Structure

- `src/lib/constants/`: Minecraft rules, XP caps, and engine search limits.
- `src/lib/core/`: Registry construction and static game rules.
- `src/lib/engine/`: Core search pipeline and probability math.
- `src/lib/services/`: Caching, serialization, and post-processing.
- `src/lib/utils/`: Generic math and data structure helpers.
- `src/lib/types/`: Branded types and domain interfaces.
- `src/ui/`: Browser UI, DOM wiring, and charts.
- `src/worker/`: Web Worker implementation.
- `tests/`: Root-level unit and integration tests.
