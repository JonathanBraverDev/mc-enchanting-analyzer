# Contributing to Minecraft Enchantment Analyzer

## Common Description

This guide is the source of truth for contributing code, preparing release branches, validating changes, and preserving release history for Minecraft Enchantment Analyzer.

## Table of Contents

- [Workflow & Branching Strategy](#workflow--branching-strategy)
- [Release PR Style](#release-pr-style)
- [Development Principles](#development-principles)
- [Linting & Style](#linting--style)
- [Testing Guidelines](#testing-guidelines)
- [Performance Profiling](#performance-profiling)
- [Mass Conservation Invariants](#mass-conservation-invariants)
- [Directory Structure](#directory-structure)
- [Troubleshooting](#troubleshooting)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Workflow & Branching Strategy

We follow a specialized workflow to keep production history clean while preserving the granular commits that explain each release.

1.  **Release snapshots (`main`)**: This branch is the source of truth for published snapshots, not a general integration branch.
    *   `main` contains tagged release snapshot commits such as `Release: vX.Y.Z`.
    *   Normal feature, performance, registry, security, and documentation work should land through a release PR rather than as standalone PRs into `main`.
    *   Rebase long-lived release work onto the current `main` snapshot before opening or updating a release PR.
2.  **Release preparation branches**: Prepare each version on a branch created from the current `main` snapshot.
    *   Keep the normal commit history on the branch. Do not squash it before opening the PR.
    *   Update `CHANGELOG.md`, `package.json`, and `package-lock.json` on this branch.
    *   For major releases, update `ARCHITECTURE.md`.
    *   For minor releases, update project docs when behavior, architecture, workflows, or user-facing capabilities changed.
    *   Lint, tests, CodeQL, and release-format checks must pass on the PR before merge.
    *   PR the release branch into `main` and merge it using **Squash and Merge**.
3.  **Release archive (`release-history`)**: This branch records the full commit history that produced each release.
    *   The release workflow replays the original release PR commits after the squash merge lands on `main`.
    *   `release-history` must match the current `main` tree before each release PR merges.
    *   Release PR history must stay linear, because `release-history` rejects merge commits.
    *   After a release branch has been archived successfully, the release workflow deletes that same-repository PR branch.
    *   Do not push to `release-history` manually; it is maintained by the release workflow.


## Release PR Style

Release PRs into `main` are policy-checked from the base branch so the release rules cannot be relaxed by editing workflow files inside the PR. Treat the PR head as release data and keep the release metadata commit predictable.

Release validation is split into separate checks so failures point at the right layer:

- `Validate Release Format`: PR title, package versions, changelog entry, PR body, and SemVer jump.
- `Validate Changelog SemVer Policy`: changelog sections that imply major/minor/patch scope, including PR comments when the proposed version should be promoted.
- `Validate Release Branch`: final release metadata commit shape, current archive state, branch base, and linear unsquashed release history.

A non-required `CI Change Advisory` check also reviews CI-sensitive file changes. It should be green when no CI-sensitive files changed, warn when CI validation logic changed, and fail red when workflow triggers, branch/path filters, permissions, job conditions, runner targets, checkout targets, or status-check names changed. A red advisory is not a merge blocker by itself; it is a reviewer signal that the PR may alter whether policy checks run at all.

### Required PR shape

- Branch from the current `main` snapshot before opening or updating the release PR.
- Keep the branch history linear; do not merge `main` into the release branch. Rebase instead.
- Preserve the full release branch history until merge. Do not pre-squash the branch locally.
- Ensure `origin/release-history` already matches `origin/main` before merging the release PR.
- Use a PR title exactly matching `Release: vX.Y.Z`.
- Put the matching `CHANGELOG.md` entry at the start or end of the PR description. The release heading date may be omitted from the PR body, but the rest of the block must match.

### Changelog section policy

Release changelog entries should use concrete section headings so release intent is machine-checkable.

| Section | Use for | Patch | Minor | Major | Version advice |
| --- | --- | --- | --- | --- | --- |
| `### Fixed` | Bug fixes, correctness fixes, release process fixes, and other patch-level repairs. | Yes | Bundled only | Bundled only | Lower minor releases that only contain fixes. |
| `### Security` | Security fixes or hardening. | Yes | Bundled only | Yes, when breaking | Lower minor releases that only contain security fixes. |
| `### Developer Experience` | Tooling, tests, CI, documentation, validation, diagnostics, and contributor workflow changes. | Yes | Yes | Bundled only | Valid for CI/tooling-only patch releases. |
| `### Added` | New user-facing or public capabilities. | No | Yes | Bundled only | Patch-incompatible. |
| `### Improved` | Meaningful improvements to existing behavior. | No | Yes | Bundled only | Patch-incompatible. |
| `### Changed` | Behavior, workflow, or API changes that are not strictly additions or fixes. | No | Yes | Bundled only | Patch-incompatible. |
| `### Deprecated` | Still-supported behavior planned for removal. | No | Yes | Bundled only | Patch-incompatible. |
| `### Removed` | Removed behavior or cleanup. | No | Yes | Usually | Minor-compatible, but reviewers must confirm it did not remove supported public behavior. |
| `### Breaking` | Breaking changes. | No | No | Required | Major-only. |

SemVer section rules:

- **Major releases** must include `### Breaking`.
- **Minor releases** must include at least one of `### Added`, `### Improved`, `### Changed`, `### Developer Experience`, or `### Deprecated`.
- **Patch releases** must include at least one of `### Fixed`, `### Security`, or `### Developer Experience`.
- Patch releases should not use `### Added`, `### Improved`, `### Changed`, `### Deprecated`, `### Removed`, or `### Breaking`.
- Minor releases may use `### Removed`, but this requires reviewer judgment: CI cannot know whether a deletion removed supported behavior or only cleaned up internal/non-breaking surface.

When a changelog section implies a larger or smaller SemVer bump, release CI posts a PR comment asking for the version to be promoted/lowered or the section to be renamed. Developer-facing patch releases are valid when they only affect tooling, CI, validation, diagnostics, documentation, tests, or contributor workflow.

### Final release metadata commit

The final commit on a release PR should be the metadata/docs commit. Use the subject format:

```text
chore(release): prepare vX.Y.Z
```

That commit must update:

- `CHANGELOG.md` with the release entry
- `package.json` with version `X.Y.Z`
- `package-lock.json` with the same root version

It may also update known release documentation such as `CONTRIBUTING.md`, `README.md`, `ARCHITECTURE.md`, or `MASS_HANDLING.md`. Keep functional source, test, and snapshot changes in earlier commits so the release commit remains easy to audit.

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

## Troubleshooting

- If the release-format check fails on the PR title, rename the PR to exactly `Release: vX.Y.Z`.
- If the PR description check fails, copy the matching release block from `CHANGELOG.md` into the beginning or end of the PR body.
- If the final release commit check fails, add a new final commit that only updates release metadata and known release docs.
- If the release archive readiness check fails, verify that `origin/release-history` has the same tree as `origin/main` before merging.
- If a workflow change is required for a release, push with credentials that have GitHub `workflow` permission; otherwise GitHub rejects `.github/workflows/*` updates.
- If `CI Change Advisory` is red, inspect workflow trigger, branch/path filter, permission, job condition, runner, checkout target, and status-check-name changes before treating the release as safe.

## References / Related Docs

- `CHANGELOG.md`
- `.github/workflows/release-check.yml`
- `.github/workflows/release.yml`
- `docs/search-function-inventory.md`

## Owner / Maintainer

JonathanBraverDev maintains this project.

## Last Updated

2026-05-13
