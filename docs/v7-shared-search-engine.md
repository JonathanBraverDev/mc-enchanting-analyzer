# V7 Shared Search Engine Design

## Common Description

This document is the working design checkpoint for the V7 engine rewrite. V7 is allowed to break the V6 engine, worker protocol, registry runtime shape, and tests in order to replace the modified-level search model with shared weighted search over reusable lazy programs.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Decisions Locked In](#decisions-locked-in)
- [Problem Statement](#problem-statement)
- [Target Architecture](#target-architecture)
- [Search Identity](#search-identity)
- [Mass Accounting](#mass-accounting)
- [Caching Model](#caching-model)
- [Worker Model](#worker-model)
- [Testing Strategy](#testing-strategy)
- [Commit Plan](#commit-plan)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Purpose / Scope

V7 replaces the current “N independent modified-level searches, then aggregate” design with a shared lazy search DAG and weighted probability flow. The rewrite may harvest useful V6 parts, but preserving V6 code structure is not a goal.

Out of scope for the first pass:

- Exact snapshot parity with V6.
- Preserving current internal engine tests.
- Preserving the current worker protocol internally.
- Full UI redesign beyond adapters needed to consume V7 output.

## Decisions Locked In

- Branch name: `rewrite/v7-shared-search-engine`.
- Base: current `main` / `v6.1.0`.
- V7 can break public/internal APIs if the result quality is better.
- Existing snapshots are reference fixtures, not exact behavioral oracles.
- Book cases may need higher limits than V6 because the current book snapshot used roughly 1.2M iterations across all modified levels.
- The V7 iteration counter may not be directly comparable to V6 once shared nodes merge mass from multiple modified levels.
- Intermittent commits are mandatory; avoid one giant uncommitted rewrite.

## Problem Statement

The current engine treats each modified level as its own search state:

```text
modified level -> pool plan -> graph -> frontier -> result
```

That loses important overlap. Adjacent modified levels often share the same eligible pool, and after level halving they frequently converge to the same future state. Searching them independently repeats structural work and delays probability mass merging until final aggregation.

V7 should instead search the real shared state space:

```text
weighted modified-level roots -> shared lazy program graph -> per-cell/accounted results
```

## Target Architecture

### RegistryKernel

Compiled immutable runtime projection for one version/request family.

Responsibilities:

- Resolve item/material/version mechanics.
- Precompute enchant IDs, ranks, weights, conflicts, and packed combo indices.
- Compute eligible pools by modified level.
- Assign `PoolSignature` values for structurally equivalent pools.
- Provide cheap access to immutable search programs.

The raw registry rule data does not need to be rewritten first; the runtime projection does.

### SearchProgram

Immutable/lazy structural graph for a pool signature.

Responsibilities:

- Canonical node IDs.
- Expansion blueprints.
- Child edge weights.
- Stop/continue probabilities.
- Book redistribution structure.
- Clue pruning structure when clue-aware search is active.

No probability mass belongs in `SearchProgram`.

### SearchRun

Mutable weighted probability flow through one or more search programs.

Responsibilities:

- Seed roots from modified-level distributions.
- Merge mass when future structure is identical.
- Schedule global node expansion by weighted impact.
- Maintain per-output-cell mass accounting.
- Produce snapshots/checkpoints for projection.

### Projection Layer

Pure reporting over search snapshots.

Responsibilities:

- Top combo summaries.
- Target filtering.
- Clue advisor projections.
- Chart cell view models.
- Human-readable snapshots.

Changing display targets or summary limits should not rerun the engine when the underlying probability snapshot is still compatible.

## Search Identity

A shared node is valid only when future behavior is identical:

```ts
type ProgramKey = {
  version: string;
  item: string;
  poolSignature: string;
  bookMode: string;
  clueMode: string | null;
};

type NodeKey = {
  selectedEnchantMask: bigint | number;
  currentLevel: number;
};
```

Two modified levels may merge only if both their `ProgramKey` and `NodeKey` match.

Pool signature must include enough data to make this safe:

- eligible enchant/rank list
- weights
- conflict masks
- rank/index packing assumptions
- book behavior
- clue policy shape, when applicable

## Mass Accounting

V7 should keep the honest accounting principle, BigInt fixed-point units, and explicit buckets:

- resolved
- clue incompatible
- pending
- sieved
- overflow
- capped
- rounding
- recovered rounding / sieved as diagnostics

The major change is where weighting happens.

V6 model:

```text
search each modified level with PRECISION mass
scale by P(modifiedLevel) during aggregation
```

V7 model:

```text
seed each modified-level root with P(modifiedLevel)
merge equivalent future mass during search
```

The invariant should hold per output cell:

```text
resolved + clueIncompatible + pending + sieved + overflow + capped + rounding == PRECISION
```

This may produce small differences from V6 because probability mass can merge before later divisions, reducing fragmentation and changing where rounding/recovered rounding appears.

## Caching Model

### DistributionCache

```ts
version + xp + enchantability + mechanics -> modifiedLevelDistribution
```

Keep the current idea.

### PoolCache

```ts
version + item + modifiedLevel -> eligible pool + poolSignature
```

Extend the current pool cache with structural signatures.

### SearchProgramCache

```ts
ProgramKey -> SearchProgram
```

Main new cache. This stores structural work without probability mass.

### SearchSnapshotCache

```ts
request signature -> SearchSnapshot
```

Stores compatible resumable search state and replaces final stats as the primary reusable artifact. Stats become derived projections.

### Optional SubtreeSummaryCache

```ts
ProgramKey + NodeKey -> fully explored subtree summary
```

Only for hot/high-value fully explored subtrees. Avoid unbounded memory growth.

## Worker Model

Workers should submit search intents, not dictate per-XP/per-modified-level granularity.

Desired model:

```text
UI input
  -> worker search intent
  -> SearchRun cells
  -> streamed SearchSnapshots
  -> projection to top/chart/target views
```

Top selected level is a one-cell batch. Chart sweep is a multi-cell batch. Refinement advances the same compatible run through stricter checkpoints instead of restarting unrelated searches.

## Testing Strategy

- Keep existing snapshots as reference material.
- Do not require exact snapshot parity.
- Add V6-vs-V7 comparison harness for broad sanity, especially top probabilities and accounting totals.
- Add mass conservation tests from the first executable V7 slice.
- Add targeted tests for:
  - pool signature equivalence
  - no unsafe merging across different pools
  - book redistribution
  - clue-conditioned pruning
  - chart batch cells
  - abort/resume behavior
- Treat old engine-internal tests as disposable once their behavior is no longer relevant.

## Commit Plan

Commit after each stable slice:

1. V7 design checkpoint.
2. RegistryKernel and PoolSignature skeleton.
3. SearchProgram structural graph skeleton.
4. Single-cell weighted SearchRun with mass conservation.
5. V6/V7 comparison harness.
6. Global modified-level scheduler.
7. Direct weighted accounting and snapshot output.
8. Worker adapter for top results.
9. Chart batch mode.
10. Projection cleanup and obsolete-test pruning.

## References / Related Docs

- `ARCHITECTURE.md` — V6 architecture map.
- `MASS_HANDLING.md` — current honest mass accounting design.
- Existing snapshot fixtures under `tests/snapshots/`.

## Owner / Maintainer

Jonathan Braver / V7 rewrite branch maintainers.

## Last Updated

2026-05-10
