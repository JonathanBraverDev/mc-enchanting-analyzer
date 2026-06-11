# Search Engine Deep Dive

## Common Description

This document is the maintained reference for search behavior. Flex search is the engine's rank-merged search model: it searches one globally weighted frontier across registry-derived shared-rank graphs, keeps probability mass in fixed-point accounting buckets, and produces checkpoint snapshots that the UI and reporting services can consume directly.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Runtime Invariants](#runtime-invariants)
- [Engine Flow](#engine-flow)
- [Implementation Shape](#implementation-shape)
- [Component Responsibilities](#component-responsibilities)
- [Factorized Tree Model](#factorized-tree-model)
- [Flex Rank Merge Model](#flex-rank-merge-model)
- [Projection and Snapshot Boundary](#projection-and-snapshot-boundary)
- [Search Identity](#search-identity)
- [Checkpoint Semantics](#checkpoint-semantics)
- [Mass Accounting](#mass-accounting)
- [Book Handling](#book-handling)
- [Clue-Conditioned Search](#clue-conditioned-search)
- [Caching Model](#caching-model)
- [Worker Model](#worker-model)
- [Remainder and Equivalence Rules](#remainder-and-equivalence-rules)
- [Optimization Layers](#optimization-layers)
- [Validation Strategy](#validation-strategy)
- [API and Migration Policy](#api-and-migration-policy)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Purpose / Scope

The search engine handles probability search, checkpointing, reporting, and worker-facing refinement. Flex search represents identical future eligibility once even when multiple exact rank pools lead there; exact ranks remain payload data until projection.

The core model is:

```text
weighted modified-level roots -> Flex shared-rank graph -> global frontier -> checkpoint snapshot
```

This document describes behavior and invariants that should remain useful across release labels.

## Runtime Invariants

- The shared-rank runtime defines product search behavior.
- Search scheduling is global: the highest-weight pending state expands next across the whole request/cell.
- `RegistryKernel` owns immutable registry projection and exact pool construction.
- `FlexSearchGraph` owns registry-derived structural graph state.
- `FlexSearchRun` owns mutable probability flow, frontier scheduling, residue, and checkpoint exits.
- `RankSelectionStore` records abstract selected factors separately from exact ranked pool payloads.
- `RankPoolStore` resolves abstract enchant IDs back to exact packed enchant ranks for projection.
- Public checkpoint outputs remain exact: `SearchResult`, combo maps, snapshots, summary aggregates, and accounting keep their supported meanings.
- Factorized pending frontier state is allowed internally; resolved user-facing combo rows remain exact.
- Canonical golden snapshots should use exhaustive searches when the case can bottom out within practical runtime/heap limits.
- Product and regression flows may use bounded checkpoints or `targetClassifiedMass` for large cases, especially modern books.
- The iteration counter is a global request budget, not a per-modified-level budget.
- Performance claims should compare classified mass, wall-clock time, and engine diagnostics, not raw iteration count alone.

## Engine Flow

```text
UI / caller request
  -> EnchantEngine
  -> SearchExecutionService
  -> ModifiedLevelDistributionService
  -> RegistryKernel / Flex rank-merge signature
  -> FlexSearchGraph
  -> FlexSearchRun global weighted frontier
  -> ProbabilityMassAccountant
  -> FlexSearchSnapshotBuilder / EngineSearchSnapshot
  -> SearchResult
  -> SummaryAggregationService / SnapshotService / reporting projections
```

The search starts by computing the modified-level distribution for the requested XP, item, material, and version mechanics. Each modified level is mapped to an eligible registry pool. Pools with equivalent future behavior share Flex graph structure through a rank-merge pool signature, so adjacent levels can converge after level halving instead of repeating the same suffix independently.

The engine then seeds each modified-level root with its weighted probability mass and advances one global frontier. Each expansion chooses the largest pending `(graphId, nodeId, factorSetId)` entry, forwards exact rank-pool payload mass through weighted edges, records resolved/terminal mass, and updates fixed-point accounting. A checkpoint snapshot is built only at requested boundaries.

## Implementation Shape

Implemented search behavior:

- `RegistryKernel` projects resolved registry state into immutable runtime lookup structures.
- Rank-merge signatures group modified levels that can reuse the same future graph even when exact enchant ranks differ.
- `FlexSearchGraph` scans registry pool entries and emits rank-agnostic alternatives that lead to child exclusion states.
- `RankSelectionStore` records selected abstract factors and factor-set identity.
- `RankPoolStore` retains exact ranked pool payloads for projection.
- `FlexSearchRun` seeds weighted modified-level roots into one best-first frontier.
- Frontier entries are keyed by graph, node, and factor set, so convergent future states merge pending mass while exact rank-pool mixes remain payload data.
- Edge-local split residue is forwarded and recovered only at the same source expansion.
- `ProbabilityMassAccountant` tracks public buckets and detailed stage/operation buckets.
- `FlexSearchSnapshotBuilder` creates engine snapshots directly from run state.
- Exact combo rows remain the result output.
- Pending frontier summaries use the native factorized shape instead of materializing every pending row by default.
- Book removal, clue conditioning, pending aggregates, and result summaries are snapshot/reporting concerns, not caller concerns.
- Async chunked checkpoint search lets worker abort signals interrupt long checkpoints.
- `exhaustive: true` forces threshold `0`, bypasses the normal iteration safety cap, and remains abortable.

Non-goals:

- No second production search runtime.
- No serialized cross-worker resume snapshot; live run caching owns resume behavior.
- No engine-owned chart matrix scheduler; the chart worker owns matrix orchestration and uses XP-cell run caching.
- No compatibility promise for internal search classes, graph IDs, node IDs, rank-pool IDs, factor IDs, or diagnostic-only scripts.

## Component Responsibilities

### RegistryKernel

Compiled immutable runtime projection for one version/request family.

Responsibilities:

- Resolve item/material/version mechanics.
- Precompute enchant IDs, ranks, weights, conflicts, packed combo indexes, and active rule data.
- Compute eligible pools by modified level.
- Assign rank-merge signatures for shared graph reuse across exact rank-variant pools.
- Provide cheap access to immutable graph inputs.

### FlexSearchGraph

Immutable/lazy structural graph for a rank-merge pool signature.

Responsibilities:

- Canonical node IDs.
- Node exclusion-mask/current-level/count state.
- Root and non-root expansion over registry pool entries.
- Emitting rank-agnostic alternatives that preserve exact future eligibility.
- Tracking graph counts and internal memory/probe diagnostics.
- Providing debug expansion objects for tests.
- Providing expansion data for the search-run hot loop.

No probability mass belongs in `FlexSearchGraph`.

### RankSelectionStore

Compact selected-factor history.

Responsibilities:

- Intern abstract pick factors and selected factor sets.
- Intern exact rank-pool mixes that carry weighted rank-pool payloads.
- Keep selected future identity separate from exact ranked payload identity.
- Expose factor and mix metadata for snapshot construction, pending summaries, and diagnostics.

### RankPoolStore

Exact rank-pool payload storage.

Responsibilities:

- Intern exact ranked modified-level pools.
- Resolve abstract enchant IDs to exact packed enchant ranks for a rank pool.
- Keep rank-variant pools separate even when they share one future graph.
- Provide projection-time lookup data without forcing graph nodes to carry exact rank identity.

Factor-set identity is separate from structural node identity. A graph node says what future search can do; a factor set says what abstract selections have already happened; a rank-pool mix says which exact ranked pools contributed the probability mass.

### FlexSearchRun

Mutable weighted probability flow through one or more grouped graphs.

Responsibilities:

- Seed modified-level root mass.
- Coordinate lazy graph expansion, frontier scheduling, mass accounting, residue, and checkpoint exit checks.
- Merge pending mass at identical future/factor-set states while merging exact rank-pool payload mixes.
- Schedule global best-first expansion.
- Forward edge mass with fixed-point residue recovery.
- Record stop mass by factor-set identity and exact rank-pool mix.
- Maintain active residue diagnostics without rescanning hot structures.
- Maintain pending and resolved mass totals incrementally for target-mass checkpoints.
- Produce run state for snapshot construction.

`FlexSearchRun` should not own registry semantics or presentation formatting. Its job is probability flow.

### FlexSearchSnapshotBuilder

Native checkpoint snapshot construction.

Responsibilities:

- Build `EngineSearchSnapshot` directly from run state.
- Maintain cumulative exact resolved combo rows.
- Maintain exact resolved aggregate buckets.
- Build factorized pending frontier summaries without forcing materialized pending rows.
- Fold detailed projection/search accounting back into public accounting units exactly.

### FlexSearchProjector

Exact output projection.

Responsibilities:

- Walk factor sets and exact rank-pool mixes into exact `PackedCombo` rows.
- Apply book-removal semantics at the result boundary.
- Apply exact clue matching and clue-incompatible projection accounting.
- Project pending aggregate summaries without materializing every pending concrete row.

### Projection and Reporting Services

Presentation/projection over checkpoint snapshots.

Responsibilities:

- Top combo summaries.
- Any/rank/count/clue aggregate scans.
- Target filtering.
- Target clue advice.
- Chart cell view models.
- Human-readable snapshots.

Changing display targets or summary limits should not rerun search when the underlying probability snapshot is still compatible.

## Factorized Tree Model

The engine separates future search identity from exact ranked result identity.

```text
FlexSearchGraph node
  future: exclusion mask + current level + enchant count

FactorSet
  selected abstract enchant IDs

RankPoolMix
  exact ranked pool payload weights
```

A shared graph node is valid only when every exact rank-pool variant has the same future eligibility after conflicts and selected enchant exclusions are applied. For example, several sword damage ranks may all block the same damage group and therefore lead to the same future search state. They can share one child node while exact ranks remain in the rank-pool payload for later projection.

This is why the runtime can explore fewer frontier entries than a concrete selected-prefix tree without weakening final output. The search loop moves mass through future behavior. Snapshot construction expands abstract factors through exact rank pools back into exact user-facing combos when rows are requested.

The graph stores nodes by rank-agnostic future identity:

```text
(exclusionMask, currentLevel, count)
```

Exact ranked payload identity is not part of the graph key. It is carried by `RankPoolMix`, so mutated registries and vanilla rank variants can share future structure only where future behavior is actually rank-agnostic.

## Flex Rank Merge Model

Rank merge is part of Flex search, not a backend selector.

The engine groups work at three different identities:

- `FlexSearchGraph` owns rank-agnostic future eligibility: exclusion mask, continuation level, enchant count, and registry facts that affect future choices.
- `RankSelectionStore` owns selected abstract factors and canonical factor sets, so different pick orders can converge when they have the same selected factors.
- `RankPoolStore` and rank-pool mixes own exact ranked payloads, so projection can still recover concrete enchant ranks for every represented modified-level pool.

This lets the hot loop merge pending mass by future behavior while preserving exact result rows. A frontier entry can represent several exact rank pools only after those pools have the same future search behavior and the same selected factor set. The exact rank-pool mix is carried as payload, not as part of the frontier merge key.

When a merged entry resolves, `FlexSearchProjector` expands the selected factors through the exact rank pools and applies book and clue rules at the output boundary. This is why shared graph counts can drop while combo rows remain exact.

Pre-8.1 grouped-Flex code is not part of the branch. Validation for this engine uses current Flex invariants, reviewed snapshots, public API/worker coverage, clue-conditioned cases, mutated-registry cases, and representative exhaustive row-shape coverage.

## Projection and Snapshot Boundary

Resolved result mass and pending frontier mass have different needs:

- Resolved result rows are user-facing and must be exact by default.
- Resolved aggregate buckets are also exact.
- Pending rows are unfinished by definition; the engine exposes exact aggregate summaries without materializing every concrete pending row unless a diagnostic path asks for it.

## Search Identity

A shared node is valid only when future behavior is identical.

```ts
type GraphKey = {
  version: string;
  item: string;
  rankMergeSignature: string;
  bookMode: string;
  clueMode: string | null;
};

type NodeKey = {
  exclusionMask: bigint | number;
  currentLevel: number;
  count: number;
};

type FrontierKey = {
  graphId: number;
  nodeId: number;
  factorSetId: number;
};
```

Two pending entries may merge only if graph identity, node identity, and factor-set identity match. Their exact rank-pool mixes are then merged as payload.

The rank-merge signature must include all data that can affect exact future search behavior:

- eligible enchant family list
- weights
- conflict masks
- book behavior
- clue policy shape, when applicable

Exact ranks and combo indexes are projection payload data, not graph identity data.

## Checkpoint Semantics

Checkpoint controls are request-global:

```text
iteration limit        = total global expansion budget for the request/cell
threshold              = global weighted frontier floor
targetClassifiedMass   = optional early stop once enough mass is no longer pending
classified mass        = resolved + clue-incompatible + overflow + capped + sieved + rounding
```

`SEARCH_ITERATION_SAFETY_CAP` is a large finite safety cap. Diagnostic bottom-out runs should use `exhaustive: true`, which sets threshold `0` and disables the normal iteration cap.

Use exhaustive mode only for validation and stress probes:

- suitable for small and most non-book snapshot cases;
- useful for convergence checks;
- dangerous for modern book cases where full bottom-out can take minutes or exceed host limits.

Result export caps are separate from search caps. `summaryLimit` and `comboLimit` control serialization of already-computed result rows; they do not reduce search work.

`targetClassifiedMass` is an early-stop condition, not a guarantee. Thresholds, iteration budgets, abort signals, and host limits can still stop a search first. When target mass stops the search, instrumentation reports `exitReason: 'mass'`.

`drainEqualMassBand` is a diagnostic/refinement option. When an iteration cap is reached, it can keep expanding pending entries at the same mass band before returning. This makes tie-heavy comparisons more stable, but product flows should leave it disabled unless they need that specific behavior.

## Mass Accounting

The engine keeps BigInt fixed-point probability mass in explicit buckets:

- resolved
- clue incompatible
- pending
- sieved
- overflow
- capped
- rounding
- recovered rounding / sieved diagnostics

The active invariant for each output cell is:

```text
resolved + clueIncompatible + pending + sieved + overflow + capped + rounding == PRECISION
```

Recovered buckets are diagnostics and are not part of active conservation.

Detailed accounting splits the same public mass into search-stage and projection-stage operations. The folded public view must match exactly:

```text
public.resolved          = projection.results.projected
public.pending           = projection.pending.projected
public.clueIncompatible  = search.clueIncompatible
  + projection.results.clueIncompatible
  + projection.pending.clueIncompatible
public.sieved            = search.sieved
public.overflow          = search.overflow
public.capped            = search.capped
public.rounding          = search.rounding
  + projection.results.loss
  + projection.pending.loss
```

The detailed view is diagnostic. The public accounting view remains the stable compatibility surface. `MASS_HANDLING.md` owns the full stage/operation reference.

The engine applies modified-level probability before graph expansion:

```text
seed each modified-level root with P(modifiedLevel)
merge equivalent future mass during search
```

That can move rounding/recovery compared with older local-search aggregation models. The invariant remains raw-unit conservation.

## Book Handling

Enchanted books have a post-processing rule: after generation, one generated enchantment slot is removed uniformly when two or more slots were produced.

The engine models search normally, then applies book removal at the projection/snapshot boundary:

- A fixed emission is one generated slot.
- A choice emission is also one generated slot; removing it drops the whole choice slot before alternatives are expanded.
- Resolved rows and aggregates include the book-removal factors.
- Pending summaries do not pretend to know the final removed slot; they summarize the unfinished frontier in the native factorized view.

This keeps the hot search loop focused on future eligibility and leaves display/result semantics at the boundary where selected factors and exact rank-pool payloads are already available.

## Clue-Conditioned Search

A table clue is exact evidence. If the user observed `Sharpness III`, the result space is conditioned on that shown clue.

The engine treats clue-conditioned search as a probability split:

- mass that cannot show the clue moves to `clueIncompatible`;
- mass that can show the clue remains in the searchable/pending or resolved space;
- pending summaries expose the known clue space and clue-joint aggregate buckets;
- resolved summaries use the same evidence when reporting clue-conditioned stats.

For a factorized choice slot, the engine does not need to expand every concrete combo just to know the clue mass. It can split by the target clue weight inside that choice and leave the remainder as non-clue or projection loss according to fixed-point rounding.

The displayed clue is not the same thing as optional result filtering. Optional result filters may use level-as-minimum semantics in UI/reporting views; they are not engine clue conditioning.

## Caching Model

### Distribution Cache

```text
version + xp + enchantability + mechanics -> modifiedLevelDistribution
```

### Pool Cache

```text
version + item + modifiedLevel -> eligible pool + poolSignature
```

Material is intentionally absent because material affects modified-level distribution, not per-level pool eligibility.

### Search Run Cache

```text
version + item + material + xp + clue + registry mutations -> FlexSearchRun
```

The run cache supports one-at-a-time checkpoint refinement. A later checkpoint with the same request signature resumes the existing run instead of restarting from the root.

### Shared Graph and Shape Caches

`FlexSearchGraph` caches reusable rank-agnostic expansion shapes where that avoids repeated registry grouping work. Hot search expansions keep exact rank payloads outside the graph, so graph reuse does not erase exact result rows.

### Selection and Projection Caches

Factor sets and rank-pool mixes are interned by `RankSelectionStore`. Snapshot construction can cache projection-friendly facts owned by the snapshot/projection layer, but those caches must not change exact per-entry rounding semantics or retain explosive concrete products for modern book cases.

## Worker Model

Top-result and chart workers both use the same search service boundary:

```text
worker request -> EnchantEngine -> SearchExecutionService -> checkpoint SearchResult
```

Workers own matrix orchestration, cancellation, and UI pacing. The engine owns one request/cell search.

Abort behavior:

- long checkpoint searches yield periodically;
- abort signals are checked between chunks;
- if sequential checkpoint work aborts after at least one checkpoint, the last completed result may be returned;
- otherwise the search rejects with `Aborted`.

## Remainder and Equivalence Rules

Fixed-point division creates remainders. The engine uses local residue rules:

- Split residue belongs to the source expansion that created it.
- Residue can be recovered only when later mass reaches the same source expansion and edge denominator.
- Residue diagnostics are tracked separately from active conservation buckets.
- Projection loss belongs to projection, not search.

Two searches are semantically equivalent when public rows, summaries, and public mass buckets match within the tolerance explicitly owned by the test. Exhaustive self-comparisons inside the current Flex engine should be exact.

For non-exhaustive checkpoints, raw iteration counts are not a semantic metric. Different tree shapes explore different node shapes. Compare classified mass, public outputs, pending mass, and accounting buckets before comparing iteration counts.

## Optimization Layers

Current optimization layers:

1. Modified-level distribution cache.
2. Registry pool cache.
3. Flex rank-merge graph reuse across exact rank-variant pools.
4. Rank-agnostic node identity for identical future behavior.
5. Abstract factor-set identity for selected enchant families.
6. Exact rank-pool mix payloads for projection.
7. Best-first global frontier with graph-scoped node indexes.
8. Cached late-forward replay for mass that reaches already-expanded frontier keys.
9. Incremental pending/resolved mass totals for target-mass checkpoints.
10. Incremental residue diagnostics.
11. Native factorized pending summaries.
12. Exact resolved aggregate maintenance.
13. Lazy pending aggregate bucket construction for snapshots that only need accounting.

Optimization rules:

- Do not move registry semantics into the coordinator.
- Do not move presentation semantics into the graph.
- Do not trade exact resolved output for speed.
- Prefer target-mass benchmarks over fixed-iteration benchmarks when comparing different tree shapes.
- Keep diagnostic scripts reusable when they catch a real class of regression.
- Do not reintroduce a second production search runtime just to compare against pre-merge Flex behavior.

## Validation Strategy

Validation should cover both exact public behavior and internal accounting shape:

- exhaustive low-XP cases;
- representative XP 30 item cases;
- modern book checkpoints at target classified mass;
- exact clue-conditioned cases;
- mutated-registry cases;
- sequential checkpoints;
- accounting detail fold-back;
- no public combo row `0`;
- resolved aggregate parity between exact and omitted-row snapshots;
- factorized pending summaries remaining stable after later checkpoints.

## API and Migration Policy

Supported product callers should use:

- `EnchantingAnalyzer`
- request/result types documented in [`public-api.md`](public-api.md)

Internal search modules are not part of the stable caller API:

- `EngineFactory`
- `RegistryFactory`
- `FlexSearchRun`
- `FlexSearchGraph`
- `RankSelectionStore`
- `RankPoolStore`
- direct graph/node/factor/rank-pool IDs
- debug/profiling scripts

## References / Related Docs

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) - system-level module map and runtime boundaries.
- [`MASS_HANDLING.md`](../MASS_HANDLING.md) - probability mass accounting reference.
- [`public-api.md`](public-api.md) - supported library surface and API policy.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) - changelog, release, and contribution policy.

## Owner / Maintainer

Jonathan Braver / search engine maintainers.

## Last Updated

2026-06-10
