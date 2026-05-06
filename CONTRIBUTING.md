# Contributing to Minecraft Enchantment Analyzer

Thank you for your interest in contributing! This document provides guidelines for development, testing, and performance profiling.

## Workflow & Branching Strategy

We follow a specialized workflow to keep production history clean while preserving the granular commits that explain each release.

1.  **Production (`main`)**: This branch is the source of truth and contains only squash-merged milestone commits.
    *   Start feature, performance, registry, and release branches from the current `main`.
    *   Rebase long-lived work onto `main` before opening or updating a release PR.
2.  **Release branches (`release/vX.Y.Z`)**: Prepare each version on a branch created from `main`.
    *   Keep the normal commit history on the branch. Do not squash it before opening the PR.
    *   Update the `CHANGELOG.md` on this branch.
    *   For major releases, update `ARCHITECTURE.md`.
    *   For minor releases, update project docs when behavior, architecture, workflows, or user-facing capabilities changed.
    *   PR the release branch into `main` and merge it using **Squash and Merge**.
3.  **Release archive (`release-history`)**: This branch records the full commit history that produced each release.
    *   The release workflow archives the original release PR head after the squash merge lands on `main`.
    *   `release-history` must match the current `main` tree before each release PR merges.
    *   Do not push to `release-history` manually; it is maintained by the release workflow.

## Development Principles

1.  **Strict Mass Conservation**: Every probability mass must be accounted for. Use `ProbabilityMassAccountant` for all search logic.
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

**Invariant**: `Resolved + Clue Incompatible + Pending + Sieved + Capped + Overflow + Rounding === 10^12` (PRECISION)

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
