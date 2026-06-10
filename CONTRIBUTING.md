# Contributing to Minecraft Enchantment Analyzer

## Common Description

This guide is the source of truth for contributing code, preparing release branches, validating changes, and preserving release history for Minecraft Enchantment Analyzer.

## Table of Contents

- [Workflow & Branching Strategy](#workflow--branching-strategy)
- [Release PR Style](#release-pr-style)
- [Development Principles](#development-principles)
- [Linting & Style](#linting--style)
- [Public API Boundary](#public-api-boundary)
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
    *   For major and minor releases, update `docs/public-api.md` so supported API policy stays current.
    *   For major releases, also update `ARCHITECTURE.md`.
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
- `Validate Release Branch`: final release metadata commit shape, current archive state, branch base, linear unsquashed release history, and snapshot commit isolation.

Non-required advisory checks review generated or CI-sensitive changes:

- `CI Change Advisory` runs from the base branch and comments on CI-sensitive file changes. It exits green and resolves any active advisory comment when no CI-sensitive behavior changed; it fails red when reviewers should inspect workflow behavior, release/advisory validator scripts, or package scripts reached from workflow-called commands.
- `Snapshot Advisory` runs from the base branch and comments when generated snapshot files changed. It exits green and resolves any active advisory comment when no snapshot files changed. A red snapshot advisory means reviewers should inspect the generated output summary before merging.
- Preview advisory jobs run from the PR branch with read-only permissions and write only to the job summary. They show branch-authored classifier output before that classifier exists on `main`; trusted base-branch advisory comments remain the source of truth. Preview jobs also exit green when their classifier finds no relevant advisory changes.

A red advisory is not a merge blocker by itself. It is a reviewer signal that the PR changes generated output, CI behavior, or the checks that decide whether release policy ran.

### Required PR shape

- Branch from the current `main` snapshot before opening or updating the release PR.
- Keep the branch history linear; do not merge `main` into the release branch. Rebase instead.
- Preserve the full release branch history until merge. Do not pre-squash the branch locally.
- Ensure `origin/release-history` already matches `origin/main` before merging the release PR.
- Use a PR title exactly matching `Release: vX.Y.Z`.
- Put the matching release notes from `CHANGELOG.md` at the start or end of the PR description. The `## vX.Y.Z` heading and date may be omitted from the PR body, but the release-note sections and bullets must match.
- Major releases should have a human-readable name because each one redefines a major part of how the project works. Use the historical heading style directly after the release heading, for example `### The "Folded Frontier" Update`.

### Changelog section policy

Release changelog entries should use concrete section headings so release intent is machine-checkable and readable.

Major release entries must also include exactly one human-readable release name heading before the normal changelog sections:

```markdown
## v8.0.0 (YYYY-MM-DD)

### The "Folded Frontier" Update

### Breaking
- ...
```

The name heading is release metadata, not a SemVer category. It follows the historical major-release style used by entries such as `The "Divide & Conquer" Update`, `The "Precision Architecture" Update`, and `The "Modernization Update"`.

Write release notes reader-first:

- User-facing sections should describe the observable outcome: what is new, fixed, faster, safer, cleaned up, removed, or behaviorally different. Avoid implementation details unless the detail is itself part of the public or diagnostic surface.
- Developer-facing sections can summarize the supporting work: tests, benchmark harnesses, release policy, diagnostics, migration notes, and documentation changes. Use docs for the deeper "how"; the changelog should be enough for users and a useful TL;DR for developers.
- When a change has both sides, put the user-visible result in `### Fixed`, `### Performance`, `### Added`, etc., then put the validation or migration detail in `### Developer Experience` or `### Documentation`.

| Section | Use for | Patch | Minor | Major | Version advice |
| --- | --- | --- | --- | --- | --- |
| `### Fixed` | User-visible bug fixes, correctness fixes, release process fixes, and other patch-level repairs. | Yes | Bundled only | Bundled only | Lower minor releases that only contain fixes. |
| `### Security` | Security fixes or hardening. | Yes | Bundled only | Yes, when breaking | Lower minor releases that only contain security fixes. |
| `### Performance` | User-visible speed, memory, startup, or responsiveness improvements. | Yes | Bundled only | Bundled only | Valid for performance-only patch releases. |
| `### Documentation` | User or contributor documentation updates, release note framing, examples, and explanatory docs. | Yes | Bundled only | Bundled only | Valid for docs-only patch releases. |
| `### Cleanup` | Internal pruning, dead-code removal, repo organization, or non-behavioral simplification that does not remove supported behavior. | Yes | Bundled only | Bundled only | Use instead of `### Removed` when supported behavior is unchanged. |
| `### Developer Experience` | Tooling, tests, CI, validation, diagnostics, benchmark harnesses, release policy, and contributor workflow changes. | Yes | Yes | Bundled only | Valid for CI/tooling-only patch releases. |
| `### Added` | New user-facing or public capabilities. | No | Yes | Bundled only | Patch-incompatible. |
| `### Improved` | Meaningful improvements to existing behavior. | No | Yes | Bundled only | Patch-incompatible. |
| `### Changed` | Behavior, workflow, or API changes that are not strictly additions or fixes. | No | Yes | Bundled only | Patch-incompatible. |
| `### Deprecated` | Still-supported behavior planned for removal. | No | Yes | Bundled only | Patch-incompatible. |
| `### Removed` | Removed supported behavior, public API, workflows, or compatibility surface. | No | Yes | Usually | Minor-compatible, but reviewers must confirm it is not breaking. |
| `### Breaking` | Breaking changes. | No | No | Required | Major-only. |

SemVer section rules:

- **Major releases** must include `### Breaking`.
- **Major releases** must include a name heading like `### The "Folded Frontier" Update`.
- **Minor releases** must include at least one of `### Added`, `### Improved`, `### Changed`, `### Developer Experience`, or `### Deprecated`.
- **Patch releases** must include at least one of `### Fixed`, `### Security`, `### Performance`, `### Developer Experience`, `### Documentation`, or `### Cleanup`.
- Patch releases should not use `### Added`, `### Improved`, `### Changed`, `### Deprecated`, `### Removed`, or `### Breaking`.
- Minor releases may use `### Removed`, but this requires reviewer judgment: CI cannot know whether a deletion removed supported behavior or only cleaned up internal/non-breaking surface.

When a changelog section implies a larger or smaller SemVer bump, release CI posts a PR comment asking for the version to be promoted/lowered or the section to be renamed. Developer-facing patch releases are valid when they only affect tooling, CI, validation, diagnostics, documentation, cleanup, tests, release policy, or contributor workflow.

Avoid ad-hoc `###` headings in new release entries. Common near-misses should map to the policy headings instead:

- Use `### Fixed` for corrected game data, restored compatibility, reliability fixes, and validation repairs.
- Use `### Added` for newly supported Minecraft versions, platforms, workflows, or public capabilities.
- Use `### Changed` or `### Removed` when support policy or public compatibility changes intentionally.
- Use `### Cleanup` for internal refactors, deleted dead code, repository reorganization, and non-behavioral simplification.
- Use `### Developer Experience` for new validation coverage, benchmark harnesses, diagnostics, or release tooling.
- Do not use `### Verified` just to say tests passed; put verification evidence in the PR/check output, or use `### Developer Experience` only when the release adds new coverage or validation behavior.

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

Minor and major release metadata commits must update `docs/public-api.md`. Major release metadata commits must also update `ARCHITECTURE.md`. This keeps the documented supported API boundary in lockstep with releases that may add, change, remove, or reclassify supported behavior.

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
- **Public API/CLI Tests**: `npm run test:public`

Ensure all of these pass before submitting changes.

## Public API Boundary

The package root (`src/lib/index.ts`) is the only supported library API. The supported surface is centered on `EnchantingAnalyzer` and the request/result types it uses. Internal aliases such as `#engine`, `#types`, `#services`, and `#lib/search/**` are repository implementation details even when they are used by the UI workers.

Public API tests enforce this boundary:

- `npm run test:public` must pass locally and in CI;
- when intentionally changing the package root API, update `docs/public-api.md` and the public facade tests;
- `npm run build` emits package declarations with TypeScript, but the generated files are not the policy source of truth;
- do not export implementation selectors, checkpoint snapshots, full registry runtime tables, or direct search classes from the package root just because they exist internally.

Use `docs/public-api.md` for the human policy. If that policy and the facade tests disagree, fix the code or docs before opening the release PR.

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

Snapshot fixture updates must be isolated in their own commits. A commit that touches `tests/snapshots/**` may not touch source, tests, docs, package metadata, or other files. This keeps generated snapshot diffs reviewable instead of mixing large JSON churn with actual logic changes.

## Performance Profiling

Performance is critical for the "Standalone HTML" version. We use dedicated benchmark and profiling scripts to track V8/Flex grouped-tree search, snapshot projection, and product-engine timing.

### Running the Benchmarks
```bash
npm run benchmark
```

The default benchmark runs `scripts/probe_flex_grouping.ts`, which measures the V8 grouped runtime on a representative modern book target-mass case and reports grouped graph, Solid/Plex, shape-cache, projection, and residue counters.

For CPU profiles of the grouped runtime benchmark, use:
```bash
npm run benchmark:cpu
```

For product-engine timing through the public engine path, use:
```bash
npm run benchmark:engine -- --version 1.21.11
```

For product-engine CPU profiles, use:
```bash
npm run benchmark:engine:cpu -- --version 1.21.11
```

For the repeatable book clue/no-clue perf cases, use:
```bash
npx tsx scripts/profile_perf_cases.ts
```

These scripts report tree shape, throughput, result counts, active search time, post-processing time, and total engine time.

### Optimizing the Search
- Keep Minecraft rule lookup in the registry/core layer, structural graph work in `FlexSearchGraph`, rank-pool/factor identity in `RankSelectionStore` and `RankPoolStore`, and weighted probability movement in `FlexSearchRun`.
- Avoid object allocation in hot loops such as graph expansion, weighted fanout, frontier push/pop, and summary aggregation.
- Prefer dense graph node IDs, packed combos, typed arrays, precomputed `SearchPoolEntry` metadata, and reusable grouped expansion shapes over repeated map/key reconstruction.
- Measure wall-clock runtime, classified mass, and projection cost, not only iteration counts. Rank merging can reduce frontier work while still exposing projection or canonicalization costs.

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
- If `Snapshot Advisory` or `Snapshot Advisory Preview` is red, inspect comparable result changes, fixture additions/removals, instrumentation summary, invariant warnings, and unknown paths before treating generated snapshot changes as intentional.

## References / Related Docs

- `CHANGELOG.md`
- `.github/workflows/release-check.yml`
- `.github/workflows/release.yml`
- `docs/README.md`
- `docs/public-api.md`
- `docs/search-engine.md`

## Owner / Maintainer

JonathanBraverDev maintains this project.

## Last Updated

2026-05-29
