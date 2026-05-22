# V7 Shared Search Engine Deep Dive

## Common Description

This document is the canonical reference for the current V7 shared search engine. V7 searches one globally weighted frontier across reusable lazy graphs, produces concrete-compatible checkpoint snapshots, and is the current supported engine path.

Opt-in Flex/factorized-tree work is documented separately in [`docs/flex-factorized-tree.md`](flex-factorized-tree.md). This page only summarizes that work where it affects the current V7 boundary.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Current Invariants](#current-invariants)
- [Engine Flow](#engine-flow)
- [Current Implementation](#current-implementation)
- [Current Architecture](#current-architecture)
- [Search Identity](#search-identity)
- [Checkpoint Semantics](#checkpoint-semantics)
- [Mass Accounting](#mass-accounting)
- [Caching Model](#caching-model)
- [Worker Model](#worker-model)
- [Remainder and Equivalence Rules](#remainder-and-equivalence-rules)
- [Optimization Layers](#optimization-layers)
- [Validation Strategy](#validation-strategy)
- [Maintenance Notes](#maintenance-notes)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Purpose / Scope

V7 is the current engine path for probability search, checkpointing, reporting, and worker-facing refinement. It replaces independent per-modified-level searches with one weighted search over reusable graph structure.

This document describes current behavior and invariants. It intentionally avoids long experiment narratives. Design notes for the in-development Flex/factorized-tree path live in [`docs/flex-factorized-tree.md`](flex-factorized-tree.md).

## Current Invariants

- V7 is the source of truth for current search behavior.
- Search scheduling is global: the highest-weight pending state expands next across the whole request/cell.
- `SearchGraph` owns immutable/lazy structural graph state; `SearchRun` owns mutable probability mass.
- Public checkpoint outputs remain concrete-compatible: `SearchResult`, `SearchRunSnapshot`, concrete combo maps, pending entries, and summary services keep their current meanings.
- Canonical golden snapshots should use exhaustive V7 searches when the case can bottom out within practical runtime/heap limits.
- Product and regression flows may use bounded checkpoints or `targetClassifiedMass` for large cases, especially modern books.
- The V7 iteration counter is a global request budget, not a per-modified-level budget.
- Performance claims require wall-clock/runtime evidence, not iteration count alone.

## Engine Flow

```text
UI / caller request
  -> EnchantEngine
  -> SearchExecutionService
  -> ModifiedLevelDistributionService
  -> RegistryKernel / SearchPoolSignature
  -> SearchGraph cache
  -> SearchRun global weighted frontier
  -> ProbabilityMassAccountant
  -> SearchRunSnapshot / SearchResult
  -> SummaryAggregationService / SnapshotService / reporting projections
```

The core search model is:

```text
weighted modified-level roots -> shared lazy graphs -> global frontier -> checkpoint snapshot
```

Adjacent modified levels often share eligible-pool structure and may converge to the same future state after level halving. V7 searches that shared state space directly instead of repeating work independently and aggregating only at the end.

## Current Implementation

Implemented V7 behavior:

- `RegistryKernel` projects resolved registry state into immutable runtime lookup structures.
- `SearchPoolSignature` groups modified levels that can reuse the same exact search graph.
- `SearchGraph` lazily creates canonical nodes, expansions, child edges, stop/continue probabilities, book behavior, and clue-pruning structure.
- `SearchRun` seeds weighted modified-level roots into one best-first frontier.
- `SearchRunFrontier` merges pending mass when future structure is identical.
- Edge-local split residue is forwarded and recovered only at the same source expansion.
- `SearchExecutionService` returns `SearchResult` backed by `SearchRunSnapshot` and supports cached refinement resume.
- Top and chart workers route unclued and clue-conditioned requests through V7.
- Async chunked checkpoint search lets worker abort signals interrupt long checkpoints.
- `exhaustive: true` forces threshold `0`, bypasses the normal iteration safety cap, and remains abortable.
- `SearchExpansionBlueprintCache` reuses candidate scans across rank-variant pool families without changing exact graph edges or output payloads.
- Suffix identity / pending suffix merging is implemented but opt-in because current profiling shows the overhead can outweigh lower iteration counts.
- Opt-in Flex internals are available through `searchBackend: 'flex'` for diagnostics and experiments. Current product/default behavior still uses concrete `SearchRun`, and concrete `SearchRun` remains the semantic reference for tests and compatibility; see [`docs/flex-factorized-tree.md`](flex-factorized-tree.md). Plex remains available as a legacy experimental comparison backend through `searchBackend: 'plex'`.

Current non-goals:

- No separate V7 worker/request abstraction unless checkpoint APIs cannot express a future feature.
- No serialized cross-worker V7 resume snapshot yet; live `SearchRun` caching is the current resume mechanism.
- No engine-owned chart matrix scheduler yet; the chart worker owns matrix orchestration and uses XP-cell run caching.
- No forced compatibility with historical V6 output shape beyond deliberate diagnostic bridges.

## Current Architecture

### RegistryKernel

Compiled immutable runtime projection for one version/request family.

Responsibilities:

- Resolve item/material/version mechanics.
- Precompute enchant IDs, ranks, weights, conflicts, packed combo indexes, and active rule data.
- Compute eligible pools by modified level.
- Assign `SearchPoolSignature` values for exact graph reuse.
- Assign `SearchPoolFamilySignature` values for blueprint-only reuse.
- Provide cheap access to immutable graph inputs.

### SearchGraph

Immutable/lazy structural graph for a pool signature.

Responsibilities:

- Canonical node IDs.
- Node combo/count/current-level state.
- Expansion blueprints and child edges.
- Stop/continue probabilities.
- Book redistribution structure.
- Clue pruning structure when clue-aware search is active.

No probability mass belongs in `SearchGraph`.

### SearchRun

Mutable weighted probability flow through one or more search graphs.

Responsibilities:

- Seed modified-level root mass.
- Coordinate lazy graph expansion, frontier scheduling, mass accounting, compact result storage, and checkpoint exit checks.
- Merge pending mass at identical future states.
- Schedule global best-first expansion.
- Maintain split residue and mass accounting.
- Produce checkpoint snapshots.

`SearchRun` should not own structural graph semantics or reporting projection semantics. Future factorized-tree work should keep it as a coordinator/mass-flow runtime: it talks to graph, frontier, accountant, result store, checkpoint policy, and projection/materialization boundaries without moving payload construction into the hot loop.

### Projection Layer

Reporting/projection over checkpoint snapshots.

Responsibilities:

- Top combo summaries.
- Any/rank/count/clue aggregate scans.
- Target filtering.
- Target clue advice.
- Chart cell view models.
- Human-readable snapshots.

Changing display targets or summary limits should not rerun the engine when the underlying probability snapshot is still compatible.

## Search Identity

A shared node is valid only when future behavior is identical.

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

Two pending entries may merge only if both graph identity and node identity match.

`SearchPoolSignature` must include all data that can affect exact future search behavior:

- eligible enchant/rank list
- weights
- conflict masks
- rank/index packing assumptions
- book behavior
- clue policy shape, when applicable

`SearchPoolFamilySignature` is weaker. It is safe only for reusable eligibility blueprints across pools that share base structural behavior while exact ranks may differ. Each graph still materializes exact child edges and combos from its own `SearchPoolEntry` list.

Suffix identity is stricter than visible combo identity. A suffix can be shared only when the node is non-root, visible combo/count/current level match, terminal behavior matches, and the future eligible edge set is equivalent. Default runs skip suffix canonicalization.

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

## Mass Accounting

V7 keeps BigInt fixed-point probability mass in explicit buckets:

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

V7 applies modified-level probability before graph expansion:

```text
seed each modified-level root with P(modifiedLevel)
merge equivalent future mass during search
```

That can move rounding/recovery compared with older local-search aggregation models. The invariant remains raw-unit conservation, not exact row-by-row parity with historical snapshots.

## Caching Model

### DistributionCache

```text
version + xp + enchantability + mechanics -> modifiedLevelDistribution
```

### PoolCache

```text
version + item + modifiedLevel -> eligible pool + poolSignature
```

Material is intentionally absent because material affects modified-level distribution, not per-level pool eligibility.

### SearchGraphCache

```text
SearchGraphKey -> SearchGraph
```

Stores structural work without probability mass. Compatible XP-cell runs can reuse graph state.

### SearchExpansionBlueprintCache

```text
SearchPoolFamilySignature + selectedMask + currentLevel + count -> eligible entry indexes + totalWeight
```

Stores reusable candidate-filter scans for rank-variant pools. Exact child node IDs, packed enchantments, and combo payloads remain graph-local.

### SearchRunCache / SearchSnapshotCache

```text
version + item + material + xp + clue/search-policy -> live SearchRun
```

Current implementation caches live XP-cell runs so later refinement checkpoints resume instead of recomputing. Refinement threshold and iteration budget are not part of the key because a later request can advance an existing compatible run.

A future serialized `SearchSnapshotCache` can replace or back the live cache if cross-worker persistence is needed.

## Worker Model

The existing checkpoint APIs express both current worker flows:

```text
searchToCheckpoint(request)
  -> advance one compatible run to one checkpoint
  -> return one result/snapshot

searchSequentialCheckpoints(request)
  -> advance one compatible run through ordered checkpoints
  -> report each checkpoint while continuing the same run
```

Top selected-level searches use sequential checkpoints for uninterrupted coarse-to-deep progress. Chart sweeps remain worker-orchestrated: the chart worker loops refinement passes and XP levels, calls `searchToCheckpoint` for each cell, and relies on run caching for resume.

Workers and reporting services consume `SearchRunSnapshot.pendingEntries` as globally weighted `(graph, node, mass, combo, count)` records. Any internal factorized/Flex path must provide a compatible materialized view unless it is exposed only through an explicit diagnostic API.

## Remainder and Equivalence Rules

Integer split residue must be handled conservatively:

- At a single expansion, compute each child share by flooring `mass * edge.weight / totalWeight`.
- Do not assign leftovers by largest-remainder order before the engine has a true equivalence basis.
- Carry weighted split residue per outgoing edge on the exact source expansion, currently `(graph, node, edge)`.
- If later mass reaches that same `(graph, node)`, distribute each edge from `incomingMass * edgeWeight + oldEdgeResidue`.
- Remove recovered residue from active `rounding` only when it becomes distributable through that same source expansion.
- Do not pool residues from different modified-level roots just because they share a pool signature.
- Pooling/recovery is valid only after mass reaches the same full equivalence point.
- Book `removeAdditional` redistribution can assign its local remainder to one equivalent redistributed output because the original leaf combo has already fully resolved.

Suffix merging is separate from residue handling. It remains opt-in because suffix identity construction and map lookups can dominate the iteration savings.

## Optimization Layers

Current optimization layers:

- Exact structural graph reuse by `SearchPoolSignature`.
- Expansion-blueprint reuse by `SearchPoolFamilySignature`.
- XP-cell `SearchRun` caching for refinement resume.
- Edge-local residue forwarding and recovery.
- Optional suffix merging by suffix identity.
- Opt-in Flex/factorized-tree experiments behind `searchBackend: 'flex'`, with Plex retained as a legacy experimental comparison backend. Concrete `SearchRun` remains the correctness reference while these paths are evaluated.

Avoid merging by visible combo alone; visible equality is not enough to prove future equivalence.

## Validation Strategy

Validation should assert V7 semantics directly:

- raw mass conservation;
- monotonic classified/resolved coverage as limits increase and thresholds decrease;
- globally balanced frontier cutoffs;
- high-resolution convergence for practical cases;
- top-result sanity and broad probability distance;
- clue-conditioned pruning and clue-known-space reporting;
- book redistribution correctness;
- chart-cell abort/resume behavior;
- cache correctness across refinement passes.

Existing V6-era snapshots are reference material only. Snapshot updates, especially for books, should be separate reviewable commits.

## Maintenance Notes

- Keep this page focused on current V7 behavior.
- Keep long experiment notes, design alternatives, and Flex/factorized-tree development details in [`docs/flex-factorized-tree.md`](flex-factorized-tree.md) or another targeted design doc.
- Keep `ARCHITECTURE.md` as the shorter system map and link here for deeper V7 reasoning.
- Keep archived inventory docs clearly marked as non-canonical research snapshots.

## References / Related Docs

- `ARCHITECTURE.md` — V7 architecture map.
- `MASS_HANDLING.md` — current V7 mass accounting and residue rules.
- `docs/flex-factorized-tree.md` — Flex/factorized-tree design and migration notes.
- `docs/plex-factorized-tree.md` — historical Plex prototype notes.
- `docs/search-function-inventory.md` — archived rename research snapshot, not canonical current behavior.
- `docs/function-behavior-inventory.md` — archived function-reading research snapshot, not canonical current behavior.
- Existing snapshot fixtures under `tests/snapshots/`.

## Owner / Maintainer

Jonathan Braver / V7 engine maintainers.

## Last Updated

2026-05-21
