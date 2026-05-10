# V7 Shared Search Engine Design

## Common Description

This document is the working design checkpoint for the V7 engine rewrite. V7 is allowed to break the V6 engine, worker protocol, registry runtime shape, and tests in order to replace the modified-level search model with shared weighted search over reusable lazy programs.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Decisions Locked In](#decisions-locked-in)
- [Problem Statement](#problem-statement)
- [Current Implementation Checkpoint](#current-implementation-checkpoint)
- [Validation Findings](#validation-findings)
- [Limit and Threshold Semantics](#limit-and-threshold-semantics)
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
- Book cases may need higher absolute limits for near-complete resolution, but V7 resolves more useful mass under the same total node budget.
- The V7 iteration counter is global and should not be compared to V6's per-modified-level iteration counter as if they were the same budget.
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

## Current Implementation Checkpoint

Current branch state after the first stack-adapter checkpoint and V7-first direction change:

- Branch: `rewrite/v7-shared-search-engine`.
- Fallback design checkpoint tag: `v7-global-search-semantics-2026-05-10` at `20b65ba`.
- Implemented V7 slices:
  - `RegistryKernel` and `PoolSignature` projection.
  - Lazy `SearchProgram` structural graph.
  - Single-cell weighted `SearchRun` with global frontier scheduling and mass conservation.
  - Configurable zero probability floor so validation can dig through the tail.
  - V6/V7 comparison harness with matched-resolved mode.
  - `V7SearchService` adapter that temporarily projects V7 snapshots into the existing `SearchResult` / `CalculationStats` boundary.
  - Top and chart workers route both unclued and clue-conditioned requests through V7.
  - V7-specific refinement thresholds so product depth settings reflect global weighted frontier semantics instead of V6 local per-modified-level semantics.
  - Node-local V7 edge-split residue forwarding inside `SearchRun`, matching V6's cautious recovery model: fixed-point split residue stays in `rounding` until later mass reaches the same `(program, node)` expansion and can recover it.
  - Pending V7 frontier projection through the compatibility adapter: snapshots now expose exact pending `(program, node)` entries with mass/combo/count for existing summary, target, clue, and chart projections.
  - Async chunked V7 adapter search so worker abort signals can be observed during long checkpoints.
  - Initial V7-native instrumentation under `EngineInstrumentation.v7` for program count, seeded levels, pending entries, largest pending mass, active residue count/mass, improvability, and V7 cache hit/miss counters.
  - V7 structural `SearchProgram` cache plus XP-cell `SearchRun` cache: one-at-a-time chart worker calls can now resume the same XP run across refinement passes while sharing structural programs across fresh runs.
- Direction change:
  - V7 is now the upgrade path and source of truth.
  - Treat V6 internals, telemetry shape, and snapshots as obsolete until re-evaluated.
  - Keep the existing engine API semantics where they fit: `searchToCheckpoint` means advance one search to one checkpoint and return; `searchSequentialCheckpoints` means advance the same search through multiple checkpoints and report along the way.
  - Do not introduce a separate V7 worker/request abstraction unless a concrete feature cannot be expressed through the existing checkpoint interfaces.
  - Do not force native V7 results or telemetry into V6 output shapes unless a temporary bridge still requires it.
- Not implemented yet:
  - Fully native V7 projection contracts beyond the compatibility adapter.
  - Serialized/cross-worker V7 search snapshots if live run caching proves insufficient.
  - Full V7 replacement tests.
- Optional/post-release:
  - Engine-owned chart batch scheduling. Current direction is that the chart worker owns matrix orchestration and repeatedly calls checkpoint APIs; V7 caching provides XP-cell resume underneath.

## Validation Findings

The current evidence supports V7's global weighted search model. V6 and V7 can return slightly different shallow book rankings because they cut different parts of the search frontier, not because V7 is losing mass.

### Matched resolved mass

When V7 is stopped at the same resolved mass as V6, non-book cases line up closely:

- `1.21.11 sword/diamond XP 30`: top-8 overlap `8/8`; combo L1 distance about `1.54%`.
- `1.8 sword/diamond XP 30`: top-8 overlap `8/8`; combo L1 distance about `0.39%`.

Book cases show more rank churn because many outputs are clustered near the same probability:

- Baseline `1.21.11 book/book XP 30`: top-8 overlap `5/8`, but top-20 overlap `20/20`; combo L1 distance about `2.21%`.
- Deep `1.21.11 book/book XP 30`: top-8 overlap `8/8`; top-20 overlap `19/20`; combo L1 distance about `2.46%`.

### Cutoff shape

The book drift is explained by cutoff shape:

- V6 applies thresholds and iteration limits inside each independent modified-level search.
- V7 applies scheduling to globally weighted frontier mass.
- Baseline book pending-node global mass spread:
  - V6: about `70,797x`.
  - V7: about `346x`.
- Deep book pending-node global mass spread:
  - V6: about `97,279x`.
  - V7: about `642x`.

This means V6 over-searches some low-probability modified levels while leaving larger unresolved chunks in high-probability levels. V7 leaves a more balanced global frontier.

### Budgeted coverage

Under the same total node budget, V7 resolves substantially more book mass. For `1.21.11 book/book XP 30`, using V6 per-level caps and giving V7 the same total node count V6 actually spent:

| V6 per-level cap | Total nodes | V6 resolved | V7 resolved | V7 advantage |
|---:|---:|---:|---:|---:|
| 5 | 55 | 10.8689% | 15.8951% | +5.0262% |
| 10 | 110 | 19.0206% | 24.6429% | +5.6223% |
| 20 | 220 | 28.7735% | 34.2312% | +5.4577% |
| 50 | 550 | 43.0442% | 49.6542% | +6.6100% |
| 100 | 1100 | 55.1493% | 61.1158% | +5.9665% |
| 250 | 2750 | 69.4391% | 75.4156% | +5.9765% |

This validates the intended V7 behavior: given a fixed budget, expand the highest global weighted frontier nodes first and maximize resolved coverage.

## Limit and Threshold Semantics

V7 should intentionally change the meaning of limits from local modified-level controls to global request controls.

Intended V7 semantics:

```text
iteration limit = total global node budget for the request/cell
threshold       = global weighted frontier floor
resolved mass   = best coverage obtainable under that budget/floor
```

V6 behavior to avoid preserving as product semantics:

```text
iteration limit = per-modified-level budget
threshold       = per-modified-level unweighted local frontier floor
aggregation     = scale each local result by P(modifiedLevel) afterward
```

The V6 behavior is useful for compatibility diagnostics only. It should not define V7 product behavior or future snapshot expectations. New V7 validation should focus on:

- mass conservation,
- monotonic resolved mass as limits increase,
- globally balanced frontier cutoffs,
- high-resolution convergence,
- top-result sanity and broad probability distance, not exact V6 snapshot parity.

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

Implemented as V7 structural cache. This stores structural work without probability mass: lazy node identity, node expansions, and pool-signature graph work. It is reusable across XP-cell runs when the version/item/book-mode/pool-signature/clue-mode are compatible.

### SearchRunCache / SearchSnapshotCache

```ts
version + item + material + xp + clue/search-policy -> SearchRun
```

Implemented initially as a live XP-cell `SearchRun` cache rather than a serialized snapshot cache. Refinement level, threshold, and iteration budget are intentionally not part of the key; later refinement calls resume and advance the same run. This gives the current one-at-a-time chart worker loop resumability without introducing a full matrix scheduler yet. A future serialized `SearchSnapshotCache` can replace or back this live run cache when cross-worker persistence is needed.

### Optional SubtreeSummaryCache

```ts
ProgramKey + NodeKey -> fully explored subtree summary
```

Only for hot/high-value fully explored subtrees. Avoid unbounded memory growth.

## Worker Model

Do not add a separate V7 worker/request abstraction for now. The existing engine interface already expresses the two useful execution modes:

```text
searchToCheckpoint(request)
  -> advance the requested version/item/material/xp/clue run to one checkpoint
  -> return one result/snapshot

searchSequentialCheckpoints(request)
  -> advance the requested version/item/material/xp/clue run through ordered checkpoints
  -> report each checkpoint while continuing the same run
```

Top selected level should continue to use sequential checkpoints when it wants uninterrupted coarse → standard → deep progress. Chart sweep should stay worker-orchestrated: the chart worker loops refinement passes and XP levels, calls `searchToCheckpoint` for each cell, and relies on the V7 XP-cell run cache so later refinement calls resume the same `SearchRun` instead of recomputing from scratch.

Current bridge state: workers still speak the existing protocol, but choose `engine: 'v7'` for both unclued and clue-conditioned top/chart searches. The compatibility adapter keeps `SummaryService`, `SnapshotService`, and existing UI contracts stable as migration scaffolding. It now projects V7 pending frontier entries back into the existing frontier scanner shape so pending mass remains visible to summaries, target analysis, clue conditioning, and chart cells. The adapter also caches V7 XP-cell `SearchRun`s, so repeated one-at-a-time calls for the same version/item/material/xp/clue can resume across refinement levels. New V7 work should prefer native `SearchRun` / `V7SearchRunSnapshot` semantics inside these checkpoint APIs rather than inventing an intermediate worker contract.

## Remainder and Equivalence Rules

Integer split residue must be handled conservatively:

- At a single expansion, compute each child share by flooring `mass * edge.weight / totalWeight`.
- Do not eagerly assign leftover fixed-point units to child edges by largest-remainder order; that changes outcome probabilities before the engine has a true equivalence basis for doing so.
- Carry the split residue on the exact source expansion, currently the same `(program, node)` identity.
- If later mass reaches that same `(program, node)`, distribute `incomingMass + oldResidue`; any residue decrease is recorded as `recoveredRounding` and removed from active `rounding`.
- Do not pool residues from different modified-level roots just because they share a pool signature.
- Pooling/recovery is valid only after mass has reached the same full equivalence point, currently the same `(program, node)` frontier entry.
- Book `removeAdditional` redistribution can assign its local remainder to one of the equivalent redistributed outputs because the original leaf combo has already fully resolved.

This keeps total bucket mass conserved without treating unrelated pre-equivalence rounding residue as shared probability.

## Future Tuning Ideas — Post Initial Release

These are intentionally not part of the initial V7 release scope. Keep the first release focused on correct V7 semantics, safe worker integration, and validation.

Possible later optimizations:

- Cross-program suffix equivalence once different initial pools reduce to the same future remaining edge set.
- Shared expansion-blueprint caching across equivalent suffix states without merging result payload state.
- Batch expansion by shared structural state to amortize frontier and distribution overhead.
- Program-local search quanta so hot programs can run several local expansions before global arbitration.
- Bounded memoized suffix summaries for fully equivalent tail states, especially for book-heavy searches.

Avoid merging by visible combo alone; that collapses incompatible future state and reintroduces the same metadata mess V7 is designed to avoid.

## Testing Strategy

- Keep existing snapshots as reference material.
- Do not require exact snapshot parity.
- Keep the V6-vs-V7 comparison harness for broad sanity, especially top probabilities and accounting totals.
- Add mass conservation tests from the first executable V7 slice.
- Add targeted tests for:
  - pool signature equivalence
  - no unsafe merging across different pools
  - book redistribution
  - clue-conditioned pruning
  - chart batch cells
  - abort/resume behavior
- Treat old engine-internal tests as disposable once their behavior is no longer relevant.
- Add budgeted-search tests that prove V7 resolves more mass than V6 under the same total node budget.
- Add monotonic coverage tests for increasing global iteration limits and decreasing global thresholds.

## Commit Plan

Commit after each stable slice:

1. V7 design checkpoint.
2. RegistryKernel and PoolSignature skeleton.
3. SearchProgram structural graph skeleton.
4. Single-cell weighted SearchRun with mass conservation.
5. V6/V7 comparison harness.
6. Matched-resolved and budgeted-resolution diagnostics.
7. Projection/snapshot output.
8. Direct weighted accounting hardening and compatibility adapters. ✅ first adapter checkpoint
9. Worker adapter for top results. ✅ top path routed through V7
10. Chart worker V7 routing. ✅ chart path routed through V7 per XP cell
11. XP-cell run caching for chart-style refinement resume. ✅ live `SearchRun` cache
12. Projection cleanup and obsolete-test pruning.
13. Optional later: engine-owned chart batch scheduling if profiling proves worker orchestration insufficient.

## References / Related Docs

- `ARCHITECTURE.md` — V6 architecture map.
- `MASS_HANDLING.md` — current honest mass accounting design.
- Existing snapshot fixtures under `tests/snapshots/`.

## Owner / Maintainer

Jonathan Braver / V7 rewrite branch maintainers.

## Last Updated

2026-05-10
