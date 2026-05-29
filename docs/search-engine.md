# Search Engine Deep Dive

## Common Description

This document is the maintained reference for search behavior. The engine searches one globally weighted frontier across registry-derived grouped graphs, keeps probability mass in fixed-point accounting buckets, and produces checkpoint snapshots that the UI and reporting services can consume directly.

The implementation still uses the internal `flex` namespace for code that can represent both singleton paths and factorized choice paths. That name is an implementation detail, not a separate product engine.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Runtime Invariants](#runtime-invariants)
- [Engine Flow](#engine-flow)
- [Implementation Shape](#implementation-shape)
- [Component Responsibilities](#component-responsibilities)
- [Factorized Tree Model](#factorized-tree-model)
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

The search engine handles probability search, checkpointing, reporting, and worker-facing refinement. It searches one weighted frontier over shared future state, and represents identical future eligibility once even when multiple enchantment choices lead there.

The core model is:

```text
weighted modified-level roots -> grouped registry graph -> global frontier -> checkpoint snapshot
```

This document describes behavior and invariants that should remain useful across release labels.

## Runtime Invariants

- The grouped search runtime defines product search behavior.
- Search scheduling is global: the highest-weight pending state expands next across the whole request/cell.
- `RegistryKernel` owns immutable registry projection and exact pool construction.
- `GroupedFlexGraph` owns registry-derived structural graph state.
- `FlexCoordinator` owns mutable probability flow, frontier scheduling, residue, and checkpoint exits.
- `FlexProgramStore` records generated result programs separately from mass movement.
- `SolidNode` represents a definite singleton transition.
- `PlexNode` represents a multiplexed enchantment choice whose alternatives share future eligibility.
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
  -> RegistryKernel / SearchPoolSignature
  -> GroupedFlexGraph
  -> FlexCoordinator global weighted frontier
  -> ProbabilityMassAccountant
  -> FlexSnapshotBuilder / EngineSearchSnapshot
  -> SearchResult
  -> SummaryAggregationService / SnapshotService / reporting projections
```

The search starts by computing the modified-level distribution for the requested XP, item, material, and version mechanics. Each modified level is mapped to an eligible registry pool. Pools with equivalent future behavior share graph structure through `SearchPoolSignature`, so adjacent levels can converge after level halving instead of repeating the same suffix independently.

The engine then seeds each modified-level root with its weighted probability mass and advances one global frontier. Each expansion chooses the largest pending `(graphId, nodeId)` entry, forwards mass through weighted edges, records resolved/terminal mass, and updates fixed-point accounting. A checkpoint snapshot is built only at requested boundaries.

## Implementation Shape

Implemented search behavior:

- `RegistryKernel` projects resolved registry state into immutable runtime lookup structures.
- `SearchPoolSignature` groups modified levels that can reuse the same exact graph.
- `GroupedFlexGraph` scans registry pool entries and groups alternatives that lead to the same child exclusion state.
- Singleton groups append fixed emissions and produce `SolidNode`s.
- Multi-alternative groups append weighted choice emissions and produce `PlexNode`s.
- `FlexProgramStore` records fixed and choice emissions as compact parent-linked program history.
- `FlexCoordinator` seeds weighted modified-level roots into one best-first frontier.
- Frontier entries are keyed by graph and node, so convergent future states merge pending mass.
- Edge-local split residue is forwarded and recovered only at the same source expansion.
- `ProbabilityMassAccountant` tracks public buckets and detailed stage/operation buckets.
- `FlexSnapshotBuilder` creates engine snapshots directly from coordinator state.
- Exact combo rows remain the result output.
- Pending frontier summaries use the native factorized shape instead of materializing every pending row by default.
- Book removal, clue conditioning, pending aggregates, and result summaries are snapshot/reporting concerns, not caller concerns.
- Async chunked checkpoint search lets worker abort signals interrupt long checkpoints.
- `exhaustive: true` forces threshold `0`, bypasses the normal iteration safety cap, and remains abortable.

Non-goals:

- No second production search runtime.
- No serialized cross-worker resume snapshot; live run caching owns resume behavior.
- No engine-owned chart matrix scheduler; the chart worker owns matrix orchestration and uses XP-cell run caching.
- No compatibility promise for internal `flex` classes, graph IDs, node IDs, or diagnostic-only scripts.

## Component Responsibilities

### RegistryKernel

Compiled immutable runtime projection for one version/request family.

Responsibilities:

- Resolve item/material/version mechanics.
- Precompute enchant IDs, ranks, weights, conflicts, packed combo indexes, and active rule data.
- Compute eligible pools by modified level.
- Assign `SearchPoolSignature` values for exact graph reuse.
- Provide cheap access to immutable graph inputs.

### GroupedFlexGraph

Immutable/lazy structural graph for a pool signature.

Responsibilities:

- Canonical node IDs.
- Node exclusion-mask/current-level/count/program state.
- Root and non-root expansion over registry pool entries.
- Grouping alternatives by child exclusion state.
- Choosing `SolidNode` vs `PlexNode` representation.
- Tracking node kind counts and internal memory/probe diagnostics.
- Providing debug expansion objects for tests.
- Providing scratch-backed search expansions for the coordinator hot loop.

No probability mass belongs in `GroupedFlexGraph`.

### FlexProgramStore

Compact generated-program history.

Responsibilities:

- Intern root, fixed-emission, and choice-emission program IDs.
- Store parent links so programs can be walked without allocating full arrays in the search loop.
- Preserve exact fixed enchant order and choice weights for result projection.
- Expose program metadata for snapshot construction, pending summaries, and diagnostics.

Program identity is separate from structural node identity. A graph node says what future search can do; a program says what the user-facing result has already generated.

### FlexCoordinator

Mutable weighted probability flow through one or more grouped graphs.

Responsibilities:

- Seed modified-level root mass.
- Coordinate lazy graph expansion, frontier scheduling, mass accounting, residue, and checkpoint exit checks.
- Merge pending mass at identical future states.
- Schedule global best-first expansion.
- Forward edge mass with fixed-point residue recovery.
- Record stop mass by `programId`.
- Maintain active residue diagnostics without rescanning hot structures.
- Produce coordinator state for snapshot construction.

`FlexCoordinator` should not own registry semantics or presentation formatting. Its job is probability flow.

### FlexSnapshotBuilder

Native checkpoint snapshot construction.

Responsibilities:

- Build `EngineSearchSnapshot` directly from coordinator state.
- Maintain cumulative exact resolved combo rows.
- Maintain exact resolved aggregate buckets.
- Build factorized pending frontier summaries without forcing materialized pending rows.
- Fold detailed projection/search accounting back into public accounting units exactly.

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

The engine separates future search identity from generated result identity.

```text
SolidNode
  program: fixed enchantment history
  future: one definite child exclusion state

PlexNode
  program: fixed history + one weighted choice slot
  future: one shared child exclusion state
```

A `PlexNode` is valid only when every alternative in its choice group has the same future eligibility after conflicts and selected enchant exclusions are applied. For example, several sword damage alternatives may all block the same damage group and therefore lead to the same future search state. They can share one child node while keeping their distinct result weights in the program.

This is why the grouped runtime can explore fewer frontier entries than a concrete selected-prefix tree without weakening final output. The search loop moves mass through future behavior. Snapshot construction expands the program factors back into exact user-facing combos when rows are requested.

The graph stores nodes by reduced identity when safe:

```text
(exclusionMask, currentLevel, count)
```

For mutated registries that break the reduced-key invariant, the engine falls back to program-aware identity so different histories do not accidentally share unsafe future state.

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
  poolSignature: string;
  bookMode: string;
  clueMode: string | null;
  identityMode: 'reduced' | 'program';
};

type ReducedNodeKey = {
  exclusionMask: bigint | number;
  currentLevel: number;
  count: number;
};

type ProgramAwareNodeKey = ReducedNodeKey & {
  programId: number;
};
```

Two pending entries may merge only if both graph identity and node identity match.

`SearchPoolSignature` must include all data that can affect exact future search behavior:

- eligible enchant/rank list
- weights
- conflict masks
- rank/index packing assumptions
- book behavior
- clue policy shape, when applicable

Reduced identity is the fast path. Program-aware identity exists for adversarial/mutated registries where two histories can have the same exclusion mask but different payload effects.

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

Detailed accounting splits the same public mass into stages and operations. The folded public view must match exactly:

```text
public.resolved          = projection.results.projected
public.pending           = projection.pending.projected
public.clueIncompatible  = search.clueIncompatible + projection.clueIncompatible
public.sieved            = search.sieved
public.overflow          = search.overflow
public.capped            = search.capped
public.rounding          = search.rounding + projection.loss
```

The detailed view is diagnostic. The public accounting view remains the stable compatibility surface.

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

This keeps the hot search loop focused on future eligibility and leaves display/result semantics at the boundary where result programs are already available.

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
version + item + material + xp + clue + registry mutations + identity mode -> GroupedFlexSearchRun
```

The run cache supports one-at-a-time checkpoint refinement. A later checkpoint with the same request signature resumes the existing run instead of restarting from the root.

### Grouped Graph and Shape Caches

`GroupedFlexGraph` caches reusable expansion shapes where that avoids repeated registry grouping work. Hot search expansions use scratch-backed arrays that are valid only during the coordinator callback, so the coordinator does not allocate frozen one-off edge arrays per expansion.

### Program and Projection Caches

Program history is interned by `FlexProgramStore`. Snapshot construction can cache projection-friendly facts owned by the snapshot/projection layer, but those caches must not change exact per-entry rounding semantics.

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

Two searches are semantically equivalent when public rows, summaries, and public mass buckets match within the tolerance explicitly owned by the test. Exhaustive self-comparisons should be exact.

For non-exhaustive checkpoints, raw iteration counts are not a semantic metric. Different tree shapes explore different node shapes. Compare classified mass, public outputs, pending mass, and accounting buckets before comparing iteration counts.

## Optimization Layers

Current optimization layers:

1. Modified-level distribution cache.
2. Registry pool cache.
3. Pool-signature graph reuse.
4. Reduced node identity when safe.
5. Program-aware fallback when reduced identity is unsafe.
6. Grouped expansion by child exclusion mask.
7. Scratch-backed search expansion path.
8. Best-first global frontier with graph-scoped node indexes.
9. Incremental residue diagnostics.
10. Native factorized pending summaries.
11. Exact resolved aggregate maintenance.
12. Lazy pending aggregate bucket construction for snapshots that only need accounting.

Optimization rules:

- Do not move registry semantics into the coordinator.
- Do not move presentation semantics into the graph.
- Do not trade exact resolved output for speed.
- Prefer target-mass benchmarks over fixed-iteration benchmarks when comparing different tree shapes.
- Keep diagnostic scripts reusable when they catch a real class of regression.

## Validation Strategy

Validation should cover both exact public behavior and internal accounting shape:

- exhaustive low-XP cases;
- representative XP 30 item cases;
- modern book checkpoints at target classified mass;
- exact clue-conditioned cases;
- mutated-registry reduced-key safe and unsafe cases;
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
- `GroupedFlexSearchRun`
- `FlexCoordinator`
- `GroupedFlexGraph`
- `FlexProgramStore`
- direct graph/node/program IDs
- debug/profiling scripts

## References / Related Docs

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) - system-level module map and runtime boundaries.
- [`MASS_HANDLING.md`](../MASS_HANDLING.md) - probability mass accounting reference.
- [`public-api.md`](public-api.md) - supported library surface and API policy.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) - changelog, release, and contribution policy.

## Owner / Maintainer

Jonathan Braver / search engine maintainers.

## Last Updated

2026-05-27
