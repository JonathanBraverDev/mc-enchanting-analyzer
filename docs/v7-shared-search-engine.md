# V7 Shared Search Engine Design

## Common Description

This document is the working design checkpoint for the V7 engine rewrite. V7 is allowed to break the V6 engine, worker protocol, registry runtime shape, and tests in order to replace the modified-level search model with shared weighted search over reusable lazy graphs.

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
- [Deferred Optimization Investigations](#deferred-optimization-investigations)
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
- Existing V6-era snapshots are reference fixtures, not exact behavioral oracles.
- Canonical golden snapshots are V7 exhaustive searches: `exhaustive: true`, full result limits, and no checkpoint threshold/iteration budget unless the test is explicitly about budget/refinement behavior.
- Modern book cases may still exceed practical runtime/heap budgets; keep those fixtures out of the golden suite until V7 can bottom them out, rather than treating a budgeted result as canonical.
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
weighted modified-level roots -> shared lazy search graph -> per-cell/accounted results
```

## Current Implementation Checkpoint

Current branch state after the V7-only migration:

- Branch: `rewrite/v7-shared-search-engine`.
- Fallback design checkpoint tag: `v7-global-search-semantics-2026-05-10` at `20b65ba`.
- Implemented V7 slices:
  - `RegistryKernel` and `SearchPoolSignature` projection.
  - Lazy `SearchGraph` structural graph.
  - Single-cell weighted `SearchRun` with global frontier scheduling and mass conservation.
  - Configurable zero probability floor so validation can dig through the tail.
  - Historical V6/V7 comparison runs with matched-resolved mode; the temporary comparison scripts have now been removed from the live tree.
  - `SearchExecutionService` boundary that returns a `SearchResult` backed by `SearchRunSnapshot`.
  - Top and chart workers route both unclued and clue-conditioned requests through V7.
  - Refinement thresholds tuned for global weighted frontier semantics instead of V6 local per-modified-level semantics.
  - Edge-local split residue forwarding inside `SearchRun`, matching V6's cautious recovery model while avoiding order-dependent child allocation: fixed-point split residue stays in `rounding` until later mass reaches the same `(graph, node)` expansion and can recover it through the same outgoing edge.
  - Pending-state projection: summary, clue conditioning, target analysis, clue advice, snapshots, and chart cells consume `SearchRunSnapshot.pendingEntries` directly.
  - Async chunked checkpoint search so worker abort signals can be observed during long checkpoints.
  - Search instrumentation under `EngineInstrumentation.search` for graph count, seeded levels, pending entries, largest pending mass, active residue count/mass, improvability, and search cache hit/miss counters.
  - Structural `SearchGraph` cache plus XP-cell `SearchRun` cache: one-at-a-time chart worker calls can now resume the same XP run across refinement passes while sharing structural graphs across fresh runs.
  - Explicit `exhaustive: true` mode for bottom-out searches: it forces threshold `0`, bypasses the normal iteration safety cap, remains abortable through async search, and is the canonical mode for golden snapshot generation. Product UI flows should still use checkpoint limits.
- Direction change:
  - V7 is now the upgrade path and source of truth.
  - Treat V6 internals, telemetry shape, and snapshots as obsolete until re-evaluated.
  - Keep the existing engine API semantics where they fit: `searchToCheckpoint` means advance one search to one checkpoint and return; `searchSequentialCheckpoints` means advance the same search through multiple checkpoints and report along the way.
  - Do not introduce a separate V7 worker/request abstraction unless a concrete feature cannot be expressed through the existing checkpoint interfaces.
  - Do not force native V7 results or telemetry into V6 output shapes unless a temporary bridge still requires it.
- Not implemented yet:
  - Serialized/cross-worker V7 search snapshots if live run caching proves insufficient.
  - Additional shared-search regression tests as new edge cases are discovered.
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
iteration limit      = total global node budget for the request/cell
threshold            = global weighted frontier floor
targetClassifiedMass   = optional early-stop target once enough mass is classified
classified mass      = non-pending bucketed mass obtainable under that budget/floor/target
```

`SEARCH_ITERATION_SAFETY_CAP` is a large finite safety cap, not an unlimited search mode. Diagnostic bottom-out runs should use `exhaustive: true`, which deliberately forces threshold `0` and disables the iteration cap so the search runs until the frontier is empty, aborts, or exhausts host resources.

No search control should be treated as a linear runtime or quality proxy. Lower limits are generally faster all else equal, and iteration count is probably the most direct work-budget metric, but runtime also depends on frontier shape, tree complexity, result projection, conditioning, and host/runtime behavior.

Result export caps are separate from search caps. `summaryLimit`/`comboLimit` only control how many already-computed combo entries are serialized into presentation output; they do not reduce search work. Normal exports are capped by `RESULT_ENTRY_SAFETY_CAP`, while `uncappedResults: true` is the explicit opt-in for larger limits or all-result exports.

`targetClassifiedMass` is first-party checkpoint control for “do we need to keep going?” behavior. It belongs on checkpoint definitions alongside threshold and limit; named refinement presets can opt in per mode/book-vs-other case, but the default named modes intentionally leave it absent. It targets non-pending mass, not result-only mass: resolved results, clue-incompatible mass, overflow, sieve/cap buckets, and rounding all count as classified because they are no longer frontier uncertainty. It is an early-stop condition, not a guarantee: threshold, iteration limits, abort signals, and host limits can still stop the search before the target is reached. When the target is the stopping condition, instrumentation reports `exitReason: 'mass'`. For convergence probes, combine it with threshold `0` and an explicit iteration/runtime budget; for true stress probes, use exhaustive mode instead.

Use exhaustive mode only for validation and stress probes:

- safe for small and most non-book snapshot cases,
- useful for V6/V7 convergence comparisons when threshold semantics differ,
- dangerous for modern book cases such as `1.21.11 book/book XP 30`, where full bottom-out can take minutes or expose memory/runtime limits.

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
- Assign `SearchPoolSignature` values for structurally equivalent pools.
- Provide cheap access to immutable search graphs.

The raw registry rule data does not need to be rewritten first; the runtime projection does.

### SearchGraph

Immutable/lazy structural graph for a pool signature.

Responsibilities:

- Canonical node IDs.
- Expansion blueprints.
- Child edge weights.
- Stop/continue probabilities.
- Book redistribution structure.
- Clue pruning structure when clue-aware search is active.

No probability mass belongs in `SearchGraph`.

### SearchRun

Mutable weighted probability flow through one or more search graphs.

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
type SearchGraphKey = {
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

Two modified levels may merge only if both their `SearchGraphKey` and `NodeKey` match.

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

Current V7 accounting conserves raw fixed-point active mass exactly: `resolved + clueIncompatible + pending + sieved + overflow + capped + rounding` must equal `PRECISION`. Recovered buckets are diagnostics and are not part of active conservation.

This may produce small differences from V6 because probability mass can merge before later divisions, reducing fragmentation and changing where rounding/recovered rounding appears. It can also increase active `rounding` in other places: V7 seeds already-weighted modified-level mass and then performs edge splits on those smaller weighted values, while V6 searched each modified level at full `PRECISION` and scaled the finished local result once during aggregation. The extra residue is tiny for bottomed-out non-book cases inspected so far, but book searches have much larger tails and should be treated as a precision/performance investigation target.

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

### SearchGraphCache

```ts
SearchGraphKey -> SearchGraph
```

Implemented as the structural graph cache. This stores structural work without probability mass: lazy node identity, node expansions, and pool-signature graph work. It is reusable across XP-cell runs when the version/item/book-mode/pool-signature/clue-mode are compatible.

### SearchRunCache / SearchSnapshotCache

```ts
version + item + material + xp + clue/search-policy -> SearchRun
```

Implemented initially as a live XP-cell `SearchRun` cache rather than a serialized snapshot cache. Refinement level, threshold, and iteration budget are intentionally not part of the key; later refinement calls resume and advance the same run. This gives the current one-at-a-time chart worker loop resumability without introducing a full matrix scheduler yet. A future serialized `SearchSnapshotCache` can replace or back this live run cache when cross-worker persistence is needed.

### Optional SubtreeSummaryCache

```ts
SearchGraphKey + NodeKey -> fully explored subtree summary
```

Only for hot/high-value fully explored subtrees. Avoid unbounded memory growth.

## Worker Model

Do not add a separate worker/request abstraction for now. The existing engine interface already expresses the two useful execution modes:

```text
searchToCheckpoint(request)
  -> advance the requested version/item/material/xp/clue run to one checkpoint
  -> return one result/snapshot

searchSequentialCheckpoints(request)
  -> advance the requested version/item/material/xp/clue run through ordered checkpoints
  -> report each checkpoint while continuing the same run
```

Top selected level should continue to use sequential checkpoints when it wants uninterrupted coarse → standard → deep progress. Chart sweep should stay worker-orchestrated: the chart worker loops refinement passes and XP levels, calls `searchToCheckpoint` for each cell, and relies on the XP-cell run cache so later refinement calls resume the same `SearchRun` instead of recomputing from scratch.

Current state: workers use the existing checkpoint-oriented protocol, but there is no engine selector and all top/chart searches route through V7. `SearchResult` contains `snapshot: SearchRunSnapshot`. Summary aggregation, clue conditioning, target analysis, clue advice, top snapshots, and chart cells consume `snapshot.pendingEntries` directly as globally weighted `(graph, node, mass, combo, count)` records. `SearchExecutionService` caches XP-cell `SearchRun`s, so repeated one-at-a-time calls for the same version/item/material/xp/clue can resume across refinement levels. New work should keep projection logic adapted to `SearchRun` / `SearchRunSnapshot` semantics rather than forcing shared search into old frontier/tracker shapes.

## Remainder and Equivalence Rules

Integer split residue must be handled conservatively:

- At a single expansion, compute each child share by flooring `mass * edge.weight / totalWeight`.
- Do not eagerly assign leftover fixed-point units to child edges by largest-remainder order; that changes outcome probabilities before the engine has a true equivalence basis for doing so.
- Carry weighted split residue per outgoing edge on the exact source expansion, currently the same `(graph, node, edge)` identity. This makes child allocation stable under harmless chunk reordering.
- If later mass reaches that same `(graph, node)`, distribute each edge from `incomingMass * edgeWeight + oldEdgeResidue`; any aggregate residue decrease is removed from active `rounding`.
- `recoveredRounding` records the gross mass made distributable only because carried residue combined with later input. This is the stable diagnostic for useful residue recovery; the old net-shrink counter was removed because it was order/chunking dependent.
- Do not pool residues from different modified-level roots just because they share a pool signature.
- Pooling/recovery is valid only after mass has reached the same full equivalence point, currently the same `(graph, node)` frontier entry.
- Book `removeAdditional` redistribution can assign its local remainder to one of the equivalent redistributed outputs because the original leaf combo has already fully resolved.

This keeps total bucket mass conserved without treating unrelated pre-equivalence rounding residue as shared probability.

## Future Tuning Ideas — Post Initial Release

These are intentionally not part of the initial V7 release scope. Keep the first release focused on correct V7 semantics, safe worker integration, and validation.

Possible later optimizations:

- Cross-graph suffix equivalence once different initial pools reduce to the same future remaining edge set.
- Shared expansion-blueprint caching across equivalent suffix states without merging result payload state.
- Batch expansion by shared structural state to amortize frontier and distribution overhead.
- Program-local search quanta so hot graphs can run several local expansions before global arbitration.
- Bounded memoized suffix summaries for fully equivalent tail states, especially for book-heavy searches.
- Delayed-scaling or factorized-mass experiments to reduce repeated integer division on already-weighted mass.
- Book-specific result-tail optimization, including better handling of redistributed book outcomes and huge low-probability combo tails.

Avoid merging by visible combo alone; that collapses incompatible future state and reintroduces the same metadata mess V7 is designed to avoid.

## Deferred Optimization Investigations

These are explicitly postponed until the V7-only path is stable. They are important, but they should not block the initial migration unless they reveal a conservation or correctness bug.

### Weighted-split residue and book precision

V7 currently performs more fixed-point divisions than V6 because modified-level probability is applied before the search enters the shared graph:

```text
V6: search local tree at PRECISION -> scale finished result by P(modifiedLevel)
V7: seed weighted root mass -> split weighted mass at every explored edge
```

This increases active `rounding` residue, especially when many small weighted masses are split through deep book trees. The raw-unit invariant still holds exactly, so this is not lost mass; it is mass classified as active rounding rather than assigned to resolved/pending/overflow buckets. For small bottomed-out non-book cases inspected during the V7-only migration, result maps matched the old snapshots after sanitization while active residue stayed around hundreds to low thousands of fixed-point units. Books may be different because those units can be a meaningful fraction of individual low-probability combo shares.

Future work should investigate:

- split `rounding` diagnostics by source: modified-level seed residue, edge-split active residue, recovered edge residue, book redistribution remainder, and deliberate pruning/sieving;
- measure active residue as a percentage of total mass and as a percentage of tail combo shares for book snapshots;
- experiment with delayed/factorized scaling so shared search can operate on larger local masses and apply modified-level weights later when it is semantically safe;
- compare any precision optimization against raw-unit conservation and against high-resolution V6/V7 reference runs;
- avoid eager largest-remainder assignment unless the equivalence basis is proven, because assigning residue across unrelated states changes probabilities.

### Book-heavy search throughput

Current quick timing evidence suggests V7 is competitive or faster for small non-book trees, but slower for large book snapshots at comparable settings. This should be treated separately from the precision issue because books stress both search breadth and result projection volume.

Future work should investigate:

- bounded subtree summaries for fully equivalent book tails;
- book redistribution aggregation that avoids materializing huge numbers of near-zero combo entries too early;
- chart/batch scheduling for book cells so shared structural work and cache locality are used deliberately;
- result-tail policies that distinguish product-facing top results from exhaustive diagnostic snapshots.

### Guardrails

- Preserve the raw active-mass invariant exactly.
- Do not merge by visible combo alone.
- Do not pool residue before mass reaches the same full equivalence point, currently `(graph, node)`.
- Treat snapshot fixture updates as separate reviewable commits, especially for books.

## Testing Strategy

- Treat existing V6-era snapshots as reference material only until regenerated.
- Canonical golden snapshots should default to exhaustive V7 search (`exhaustive: true`) with full result limits when the case can bottom out within local runtime and heap budgets.
- Non-exhaustive snapshots/checkpoints are valid only for tests that explicitly target budget, threshold, refinement, or mass-target behavior.
- The modern `1.21.11 book/book XP 30` regression fixture is intentionally mass-targeted at 99.95% classified mass while preserving the full classified combo distribution; exhaustive bottom-out remains a stress/throughput problem, not the golden release gate.
- Do not require exact parity with historical V6 fixtures.
- Treat historical V6-vs-V7 comparison output as reference material only; live tests should assert V7 semantics directly.
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
2. RegistryKernel and SearchPoolSignature skeleton.
3. SearchGraph structural graph skeleton.
4. Single-cell weighted SearchRun with mass conservation.
5. V6/V7 comparison harness.
6. Matched-resolved and budgeted-resolution diagnostics.
7. Projection/snapshot output.
8. Direct weighted accounting hardening and compatibility adapters. ✅ first adapter checkpoint
9. Worker adapter for top results. ✅ top path routed through V7
10. Chart worker V7 routing. ✅ chart path routed through V7 per XP cell
11. XP-cell run caching for chart-style refinement resume. ✅ live `SearchRun` cache
12. Projection cleanup and obsolete-test pruning. ✅ shared-search projection path, obsolete search tests/scripts removed
13. Optional later: engine-owned chart batch scheduling if profiling proves worker orchestration insufficient.

## References / Related Docs

- `ARCHITECTURE.md` — V7 architecture map.
- `MASS_HANDLING.md` — current honest mass accounting design.
- Existing snapshot fixtures under `tests/snapshots/`.

## Owner / Maintainer

Jonathan Braver / V7 rewrite branch maintainers.

## Last Updated

2026-05-10
