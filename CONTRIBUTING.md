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
3.  **BigInt for Math**: Use high-precision `bigint` (scaled to `2^60`) for all core probability calculations. Only convert to `number` in reporting and UI-facing services.
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

Performance is critical for the "Standalone HTML" version. We use dedicated profiling scripts to track search time, post-processing time, and cache behavior.

### Running the Benchmarks
```bash
npm run benchmark -- --version 1.21.11
```

For CPU profiles, use:
```bash
npm run benchmark:cpu -- --version 1.21.11
```

For the repeatable book clue/no-clue perf cases, use:
```bash
npx tsx scripts/profile_perf_cases.ts
```

These scripts report result counts, active search time, post-processing time, and total engine time. `scripts/benchmark_engine.ts` remains available for simple cold/warm cache smoke checks.

### Optimizing the Search
- Keep Minecraft rule logic in `SearchProcessor`, mass forwarding in `MassForwardingEngine`, and queue orchestration in `SearchController`.
- Avoid object allocation in hot loops such as `processInitialNode`, `buildExpansionBlueprint`, and forwarding by node ID.
- Prefer graph node IDs, packed combos, typed arrays, and precomputed pool metadata over repeated map/key reconstruction.

## Mass Conservation Invariants

The engine maintains a system of "buckets" to track every atom of probability:
- **Resolved**: Reached a terminal enchantment combo.
- **Clue Incompatible**: Proven unable to match the observed clue in a clue-aware search.
- **Pending**: Remaining in the frontier (incomplete search).
- **Sieved**: Pruned because probability fell below `SEARCH_CONSTANTS.SYSTEM_THRESHOLD_FLOOR`.
- **Overflow**: Discarded by engine limits (6+ enchants).
- **Capped**: Pruned because result limit or heap size was reached.
- **Rounding**: Compensation for fixed-point math adjustments.

**Invariant**: `Resolved + Clue Incompatible + Pending + Sieved + Overflow + Capped + Rounding === 2^60` (PRECISION)

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
