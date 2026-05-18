# V7 Shared Search Engine Deep Dive

## Common Description

This document is the canonical deep-dive reference for the current V7 shared search engine. It explains the non-naive design: V7 searches one globally weighted frontier across reusable lazy graphs instead of running independent modified-level searches and aggregating afterward.

The document also records experimental ideas and optimization notes, but current behavior is called out separately from future work.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Current Invariants](#current-invariants)
- [Problem Statement](#problem-statement)
- [Current Implementation](#current-implementation)
- [Validation Findings](#validation-findings)
- [Limit and Threshold Semantics](#limit-and-threshold-semantics)
- [Current Architecture](#current-architecture)
- [Search Identity](#search-identity)
- [Mass Accounting](#mass-accounting)
- [Caching Model](#caching-model)
- [Worker Model](#worker-model)
- [Remainder and Equivalence Rules](#remainder-and-equivalence-rules)
- [Optimization Layers](#optimization-layers)
- [Experimental / Future Work](#experimental--future-work)
- [Testing Strategy](#testing-strategy)
- [Maintenance Notes](#maintenance-notes)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Purpose / Scope

V7 is the current engine path. It replaces the naive “N independent modified-level searches, then aggregate” model with a shared lazy graph model and weighted probability flow. The purpose of this document is to explain the current behavior deeply enough that future optimization work can preserve correctness rather than accidentally reintroducing V6 assumptions.

This file is not a release plan. It may contain experimental/future-work sections, but those sections are explicitly labeled.

## Current Invariants

- V7 is the upgrade path and source of truth for current search behavior.
- Existing V6-era snapshots are reference fixtures, not exact behavioral oracles.
- Canonical golden snapshots are V7 exhaustive searches: `exhaustive: true`, full result limits, and no checkpoint threshold/iteration budget unless the test is explicitly about budget/refinement behavior.
- Modern book exhaustive cases may still exceed practical runtime/heap budgets; product and regression flows use bounded checkpoints or mass-targeted snapshots where appropriate.
- Book cases may need higher absolute limits for near-complete resolution, but V7 resolves more useful mass under the same total node budget.
- The V7 iteration counter is global and should not be compared to V6's per-modified-level iteration counter as if they were the same budget.
- Performance claims must be measured by wall-clock/runtime evidence, not iteration count alone.

## Problem Statement

The naive/older engine model treated each modified level as its own search state:

```text
modified level -> pool plan -> graph -> frontier -> result
```

That loses important overlap. Adjacent modified levels often share the same eligible pool, and after level halving they frequently converge to the same future state. Searching them independently repeats structural work and delays probability mass merging until final aggregation.

V7 searches the real shared state space:

```text
weighted modified-level roots -> shared lazy search graph -> per-cell/accounted results
```

## Current Implementation

Current implemented V7 behavior:

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
- Generalized expansion-blueprint reuse across rank-variant pools. `SearchPoolFamilySignature` groups pools that share base enchant/conflict/weight structure while differing by exact packed ranks; `SearchExpansionBlueprintCache` reuses eligible-entry scans across those families without changing exact graph edges or combo payloads.
- Suffix identities and pending suffix merging are fully implemented but experimental and off by default. `SearchGraph.getSuffixIdentity()` can identify non-root nodes with the same visible combo and future expansion, and `SearchRun` can canonicalize matching pending entries when `useSuffixMerging: true`; current profiling shows the identity/cache overhead can outweigh the lower iteration count, so product/default searches leave it disabled.

Current boundaries and intentional non-goals:

- Keep the existing engine API semantics where they fit: `searchToCheckpoint` advances one search to one checkpoint and returns; `searchSequentialCheckpoints` advances the same search through multiple checkpoints and reports along the way.
- Do not introduce a separate V7 worker/request abstraction unless a concrete feature cannot be expressed through the existing checkpoint interfaces.
- Do not force native V7 results or telemetry into V6 output shapes unless a temporary bridge still requires it.
- Serialized/cross-worker V7 search snapshots are not implemented; live `SearchRun` caching is the current resume mechanism.
- Engine-owned chart batch scheduling is not implemented; the chart worker owns matrix orchestration and V7 caching provides XP-cell resume underneath.

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

V7 intentionally changes the meaning of limits from local modified-level controls to global request controls.

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

## Current Architecture

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

`SearchPoolFamilySignature` is a weaker, blueprint-only identity for pools with the same base enchant IDs, weights, and conflict masks while exact ranks may differ. It is safe for reusable eligibility blueprints because each graph still materializes edges against its own exact `SearchPoolEntry` list; it is not a replacement for `SearchPoolSignature` when node identity, combo identity, or output payloads matter.

Suffix identity is stricter than visible combo identity. A suffix can be shared only when the node is non-root, the visible combo/count/current level match, terminal behavior matches, and the future eligible edge set is equivalent. The current implementation uses suffix identity only when `useSuffixMerging: true`; default runs skip this canonicalization.

## Mass Accounting

V7 keeps the honest accounting principle, BigInt fixed-point units, and explicit buckets:

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

The invariant holds per output cell:

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

### SearchExpansionBlueprintCache

```ts
SearchPoolFamilySignature + selectedMask + currentLevel + count -> eligible entry indexes + totalWeight
```

Implemented as a reusable candidate-filter cache. It saves repeated full-pool scans for rank-variant pools that share the same structural eligibility behavior. The cached value contains entry indexes and total weight only; child node IDs, exact packed enchantments, and combos remain graph-local.

Current diagnostics report blueprint hits/misses, baseline candidate checks, actual candidate checks, and saved checks. This optimization is enabled by default because it preserves exact expansion edges and has shown direct candidate-check savings without changing search state.

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

Top selected level uses sequential checkpoints when it wants uninterrupted coarse → standard → deep progress. Chart sweep remains worker-orchestrated: the chart worker loops refinement passes and XP levels, calls `searchToCheckpoint` for each cell, and relies on the XP-cell run cache so later refinement calls resume the same `SearchRun` instead of recomputing from scratch.

Current state: workers use the existing checkpoint-oriented protocol, but there is no engine selector and all top/chart searches route through V7. `SearchResult` contains `snapshot: SearchRunSnapshot`. Summary aggregation, clue conditioning, target analysis, clue advice, top snapshots, and chart cells consume `snapshot.pendingEntries` directly as globally weighted `(graph, node, mass, combo, count)` records. `SearchExecutionService` caches XP-cell `SearchRun`s, so repeated one-at-a-time calls for the same version/item/material/xp/clue can resume across refinement levels. New work must keep projection logic adapted to `SearchRun` / `SearchRunSnapshot` semantics rather than forcing shared search into old frontier/tracker shapes.

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

Suffix merging is a separate experimental optimization on top of these equivalence rules. When enabled, pending arrivals whose suffix identity matches an existing canonical pending target are redirected to that target before frontier insertion. This can reduce frontier pops/iterations and materialized structural expansions, but it also performs suffix identity construction and map lookups on pending pushes. Current exhaustive probes found that cost can dominate: for example, `1.7.2 book/book XP 30` reduced iterations substantially but increased wall-clock runtime, so suffix merging remains opt-in only.

## Optimization Layers

Current optimization layers:

- Exact structural graph reuse by `SearchPoolSignature`.
- Generalized expansion-blueprint reuse by `SearchPoolFamilySignature`; enabled by default because exact edges and combos remain graph-local.
- XP-cell `SearchRun` caching for refinement resume.
- Edge-local residue forwarding for later recovery at the same source expansion.
- Optional suffix merging by suffix identity; implemented but off by default because current profiling shows its canonicalization overhead can outweigh its lower iteration count.

Avoid merging by visible combo alone; that collapses incompatible future state and reintroduces the same metadata mess V7 is designed to avoid.

## Experimental / Future Work

Possible later optimizations:

- Cross-graph suffix equivalence once different initial pools reduce to the same future remaining edge set.
- Shared expansion-blueprint caching across equivalent suffix states without merging result payload state.
- Cheaper suffix identity/canonicalization if profiling shows a way to keep the iteration savings without the current per-pending overhead.
- Batch expansion by shared structural state to amortize frontier and distribution overhead.
- Program-local search quanta so hot graphs can run several local expansions before global arbitration.
- Bounded memoized suffix summaries for fully equivalent tail states, especially for book-heavy searches.
- Delayed-scaling or factorized-mass experiments to reduce repeated integer division on already-weighted mass.
- Book-specific result-tail optimization, including better handling of redistributed book outcomes and huge low-probability combo tails.
- Abstract mutually exclusive choice edges that defer exact member materialization only when all grouped members have identical future behavior; see [Conflict-group squash](#conflict-group-squash).

These are not current behavior. They are active investigation areas for future performance, precision, or maintainability work, and they should not be treated as release promises.

### Conflict-group squash

> Planning note: this section was amended 40 times before implementation started. The 40th amend was adding this note.

Conflict-group squash is the next candidate optimization after generalized expansion blueprints and suffix-sharing diagnostics. The goal is to share search work across mutually exclusive enchantment choices that produce the same future eligibility state, while delaying exact visible combination materialization until output/resolution time.

Terminology note: the structural aggregate node is a **plex node**. The implementation now uses `Plex*` names for this aggregate structural path: one structural node can carry multiple unresolved concrete combo states in plex.

The core structural idea is to key a plex node by:

```ts
(exclusionMask, currentLevel, count)
```

instead of the current selected-prefix node identity:

```ts
(selectedMask, currentLevel)
```

For an entry, the exclusion mask would be:

```ts
entry.blocksBitset = entry.idBit | entry.conflictBitset;
```

Eligibility in plex mode becomes a single future-state check:

```ts
(exclusionMask & entry.idBit) === 0n
```

and a child transition becomes:

```ts
childExclusionMask = exclusionMask | entry.blocksBitset;
nextLevel = Math.floor(currentLevel / 2);
nextCount = count + 1;
```

This must not be implemented by simply changing current `SearchGraph` node keys. Current nodes own one visible `combo`, while plex structural nodes may represent many visible combo prefixes.

The preferred payload model is an aggregate combo expression, not immediate concrete combo generation. For example, a branch could internally represent:

```text
Unbreaking III + (Sharpness IV | Smite IV | Bane of Arthropods IV) + Looting III
```

and only expand it at snapshot/result materialization into:

```text
Unbreaking III + Sharpness IV + Looting III
Unbreaking III + Smite IV + Looting III
Unbreaking III + Bane of Arthropods IV + Looting III
```

When every member has the same future exclusion mask, the rest of the tree does not care which concrete member was picked. Selecting any member removes the whole group from future eligibility, so the parent can expose one aggregate structural edge whose effective edge weight is the sum of the member weights. The child structural state is then based on the shared exclusion mask, and later search can proceed once for the group.

The concrete member choice is still real probability mass, just delayed. At materialization time the aggregate choice can expand according to the member alternatives, for example weighted by each member's original edge weight within the aggregate group. This is the intended load shift: reduce structural branching now, expand visible combinations later.

The aggregate expression still needs probability metadata. A plain unweighted set of alternatives is not enough because alternatives can have different edge weights, incoming masses, and BigInt split residues. A naive “combined edge now, split evenly at snapshot” would be wrong, and even “split by weight at snapshot” can change unit-level rounding unless residue state is preserved. Keep the semantic choice payload lean and keep accounting beside it:

```ts
type PlexCombo = {
  fixed: readonly PackedEnchant[];
  choices: readonly PlexChoiceGroup[];
};

type PlexChoiceGroup = {
  blocksBitset: bigint;
  alternatives: readonly PackedEnchant[]; // canonical sorted exact edge-local alternatives
  key: ChoiceListKey; // PackedCombo fast path or sorted-list fallback
};

type ChoiceListKey =
  | { kind: 'packedCombo'; value: PackedCombo }
  | { kind: 'packedEnchantList'; value: readonly PackedEnchant[] };

type PlexAccountingState =
  | { mode: 'concrete-equivalent'; /* per-choice/per-edge split and residue state */ }
  | { mode: 'factorized'; /* exact aggregate factors, quantized at materialization */ };
```

The plex representation should be compatible with the existing concrete payload shape, but it should not force a big-bang redesign of the current concrete engine/cache. The strategic direction can still be for plex to become the better internal engine model if the prototype proves itself. The safe path is staged: build an opt-in plex path, prove degenerate parity, prove real-choice parity, benchmark, then decide whether the old concrete path becomes a compatibility/reference implementation rather than the primary internal model.

A plain concrete combo can be represented as the degenerate case of a plex expression inside the opt-in plex path:

```ts
// Equivalent in essence to today's concrete `PackedCombo` state inside plex mode.
const concreteCombo: PlexCombo = {
  fixed: [unbreakingIII, lootingIII],
  choices: []
};
```

If all plex-specific fields are empty/default (`choices.length === 0`, no choice DAG, and default concrete-equivalent accounting beside the combo), the expression should compare equal in essence to the corresponding concrete combo. That bridge is for the new opt-in path, not a requirement to wrap every existing `SearchRun` node. Incremental adoption should be:

- keep current concrete `SearchRun` and graph cache behavior intact by default while the new path is experimental;
- add a separate plex run/graph mode or run type with a distinct cache key;
- use degenerate plex payloads only inside that mode as a parity bridge;
- materialization of a degenerate expression is just the original `PackedCombo`;
- tests can assert that degenerate plex mode is behaviorally identical to current `SearchRun` before enabling real choice groups;
- if parity and benchmarks are strong, let the plex path graduate into the default internal implementation while preserving the public API and snapshot contracts;
- after it becomes default, keep the old concrete path as a reference/fallback for at least one release window, then deprecate/remove it only when diagnostics show it is no longer needed.

Rollout policy should therefore be explicit:

1. **Experimental opt-in**: plex mode exists behind a flag/config path and is tested against the concrete engine.
2. **Default internal engine**: after parity, residue diagnostics, and benchmarks are acceptable, plex becomes the default implementation while public APIs remain stable.
3. **Concrete fallback/reference**: the old concrete path remains available for debugging, regression comparison, and rollback.
4. **Deprecation/removal**: remove the old path only after a release window with confidence that the plex path covers the same behavior and operational needs.

Multiple independent choice groups may become a compressed product, but exactness must win over compression. If BigInt flooring or later branch choices create correlations between groups, the accounting state may need a small choice DAG or joint-distribution representation rather than independent marginal weights. Snapshot expansion is the compatibility boundary that can turn aggregate expressions back into concrete `PackedCombo` result rows.

Mass ownership should stay inside the engine, not leak into the UI/projection layer. Aggregate combos are an internal IR, and the materializer that expands them into concrete `PackedCombo` rows is part of the engine contract. The reporting layer may request materialized rows, but it must not be responsible for choosing how probability mass or rounding residue is distributed.

Resolved-result handling should preserve the plex internally. Current `SearchRun` writes `PackedCombo -> mass` into `results` as soon as a node stops, but doing that eagerly for aggregate payloads would destroy much of the intended compression at exactly the point where book/product tails can explode. A plex node that resolves should move from pending work into an internal resolved-plex store, not immediately expand into every concrete combo.

So first-pass boundaries are:

- pending frontier: may hold plex payload buckets that still need search expansion;
- resolved internal state: may hold plex payloads that need no more search expansion but are not eagerly materialized;
- public snapshot/projection: receives a resolved view materialized into normal `PackedCombo -> mass` rows when compatibility requires it;
- snapshot materializer: emits views and applies engine-owned mass/accounting rules, but does not become the owner of probability decisions.

This keeps resume/refinement safe as long as the cached run owns both pending and resolved plex state. `SearchStateCache` currently resumes by keeping a live `SearchRun` object in memory, including frontier mass, resolved results, residue, and accounting. Public snapshots are materialized views, not the source used to reconstruct a run. Under the plex model, refinement continues from the live internal state: pending plex buckets keep expanding, and resolved plex buckets remain available for later materialized views without redoing search. If future work adds serialized resume-from-snapshot, the persistence schema must include aggregate expressions, payload identities, resolved-plex buckets, and residue/accounting state.

The compatibility rule becomes: keep the internal engine state compressed as long as possible, but make the public snapshot look like current `SearchRunSnapshot` unless an explicit diagnostic/experimental API asks for plex rows.

API compatibility check:

- `EnchantEngine.searchToCheckpoint`, `searchSequentialCheckpoints`, and `getStats` can be served by plex as long as `SearchResult.combos`, `snapshot.results`, `snapshot.mass`, and public instrumentation keep their current meanings.
- `SnapshotService`, `SummaryAggregationService`, `ClueAnalysisService`, `TargetAnalysisService`, and `TargetClueAdvisorService` currently consume concrete `PackedCombo` result maps and concrete `PendingFrontierEntry` rows. They either need a materialized pending/resolved view or explicit plex-aware scanners. First pass should provide the materialized view and keep those services unchanged.
- `pendingEntries` is the sharpest compatibility edge: today each row has one `combo`, `count`, and `mass`. A plex bucket may represent many concrete combos. Public snapshots must either expand it into compatible concrete pending rows or expose plex rows only through a separate experimental diagnostics field/API.
- `SearchRun`, `SearchGraph`, `SearchStateCache`, and their diagnostics are exported from `#lib/search/index.js` and therefore are technically public even if mostly used internally. Do not silently replace their method contracts in a minor release. Add a separate plex run/graph type or mode first; only deprecate the concrete exports after a release window.
- Instrumentation fields such as `pendingEntryCount`, `queueSize`, `resultsSize`, and graph diagnostics need stable semantics. If we want structural plex counts, expose them as additional diagnostics rather than changing existing fields to mean something else.

Versioning should distinguish the engine/library surface from the end-product surface. Replacing or breaking exported low-level search classes can be an engine/library major even when the user-facing product behavior is a minor change or a no-op. Conversely, if `EnchantEngine`, snapshots, UI views, and worker outputs keep the same contracts, the application can treat plex as an internal implementation swap.

Do not split the repo or maintain a separate engine version yet. The project currently ships as one package/version, so package semver still has to account for exported low-level APIs. Use one version and make the changelog explicit with subsections:

- **User-facing / product behavior**: UI, worker output, public snapshots, visible result changes.
- **Engine/search internals**: plex implementation, cache/search architecture, diagnostics, performance.
- **Low-level API compatibility**: call out breaking changes to exported `SearchRun`, `SearchGraph`, `SearchStateCache`, or search diagnostics separately from end-product behavior.

If only internal implementation changes and supported public contracts remain compatible, this can be a minor. The package currently exposes only the root export (`.`), but `src/lib/index.ts` re-exports `./search/index.js`, which makes `SearchRun`, `SearchGraph`, and `SearchStateCache` reachable from the package root. Those are technically exported, but they should be classified explicitly before letting them dictate every release:

- **Supported public API**: `EngineFactory` / `EnchantEngine` construction plus the small product-facing engine surface used by workers/tests:
  - `getStats(request)` for direct summarized results and simple tests;
  - `searchToCheckpoint(request)` for chart cells and explicit checkpoint tests;
  - `searchSequentialCheckpoints(request)` for top-worker progressive refinement.
- **Supported read-only context**: `engine.registry` and public request/result/view types needed by workers, snapshot projection, and tests.
- **Incidental/advanced exports**: low-level search internals such as `SearchRun`, `SearchGraph`, `SearchStateCache`, structural diagnostics, and experimental search knobs.

If low-level search exports are not meant to be stable standalone SDK APIs, document them as advanced/internal-ish before changing them, then use deprecation/release notes instead of pretending they were never exported. If there is evidence of real external use, treat breaking them as a package major. Splitting versions or repos should wait until there is real external demand for independently consuming the engine package.

The current intended API is therefore much smaller than the accidental root export surface. It is essentially the worker-facing engine API plus a convenience path for tests that want results without manually choosing progressive checkpoints. Plex should target this surface first; low-level search classes can remain implementation details unless/until there is a deliberate standalone engine SDK.

A suspiciously convenient but honest public API boundary for the V7 line:

```ts
const engine = EngineFactory.createForVersion(version);

await engine.getStats({ item, material, xp, clue?, threshold?, maxIterations?, summaryLimit? });
await engine.searchToCheckpoint({ item, material, xp, clue?, threshold?, maxIterations?, targetClassifiedMass? });
await engine.searchSequentialCheckpoints({ item, material, xp, clue?, checkpoints, onCheckpointComplete });

engine.registry; // read-only context for validation/projection
engine.resetCaches();
engine.getCacheMetrics();
```

Those methods must keep returning product-compatible `SearchResult` / stats objects even if the internal search is concrete or plex. `SearchResult.snapshot` should be treated as a compatibility view consumed by project code, not as a promise that the internal engine state is concrete. Its stable commitments are the fields workers/projection need: concrete `results`, materialized-compatible `pendingEntries`, mass/accounting totals, iteration/progress fields, and instrumentation inputs. Internal plex rows should require an explicit experimental diagnostics path.

Snapshot projection is a separate boundary. `SnapshotService.create(...)` is currently used by workers as the app's projection adapter, but it is not exported from the package root and should not be promoted to standalone public SDK surface yet. For now, treat it as **app-internal but worker-stable**: plex must keep it working through materialized snapshot views, but we should avoid promising its exact API to outside consumers until the projection/view contract is deliberately designed.

API-boundary cleanup can still happen in the V7 line if it is mostly declarative and additive:

- define the supported public API in docs/changelog without removing existing root exports;
- mark low-level search exports as advanced/experimental/internal-ish in documentation and generated typings where practical;
- add replacement public entry points if needed before removing anything;
- keep root export removals, hard renames, or incompatible `SearchRun`/`SearchGraph` contract changes for a future V8-style major.

So plex itself does not force V8. V8 is the right label only if the release actually breaks package-level consumers of currently exported low-level search APIs. A V7 minor can prepare the boundary and ship opt-in plex if supported public behavior remains compatible.

This suggests a thin normalization layer between plex search and public snapshots:

```text
PlexRun internal state
  -> EngineResultMaterializer / SnapshotNormalizer
  -> normal SearchRunSnapshot-compatible rows
  -> projection/UI/reporting
```

That layer's job is to “chew” the engine shorthand into the shape the rest of the code already understands:

- expand aggregate choice expressions into concrete `PackedCombo` rows;
- apply engine-owned mass and residue rules;
- preserve current snapshot/result contracts where possible;
- keep aggregate-only diagnostics available for performance investigations;
- prevent UI/projection code from learning plex internals.

In other words, the engine may use nerdy shorthand internally, but it must hand the rest of the system ordinary engine results.

There are two possible accounting modes:

1. **Concrete-equivalent accounting**: carry enough per-alternative numerator/residue state that expanding the aggregate produces the same fixed-point results as if every concrete edge had been searched separately. This should be the first correctness target because it gives parity against current `SearchRun`.
2. **Factorized accounting**: carry exact aggregate weights and delay quantization until materialization. This may be mathematically cleaner and faster, but it changes where fixed-point rounding occurs. If used, the engine must expose that as an intentional accounting mode with its own invariants, not as an accidental projection detail.

Initial plex search should use concrete-equivalent accounting unless benchmarks prove the overhead erases the structural win. Any rounding units introduced or recovered by aggregate expansion should be recorded in engine mass diagnostics, not blamed on snapshot generation.

A safe implementation needs a separate opt-in plex graph/executor or an explicit mode where `SearchRun` owns these aggregate combo expressions per pending structural node.

Plex must separate structural frontier state from visible combo payload state. The current frontier merges pending work by `(graphId, nodeId)` and stores one mass per structural node. That remains the right heap shape for sharing search work, but the plex node needs a payload bucket behind it:

```ts
type PlexFrontierBucket = {
  graphId: number;
  nodeId: PlexNodeId;
  totalMass: bigint; // heap priority and stop-threshold input
  payloads: PlexPayloadSet;
};

type PlexPayload = {
  combo: PlexCombo;
  mass: bigint;
  accounting: PlexAccountingState;
};
```

Expanding a plex structural node should compute its eligible edges once, then apply the same expansion to every payload in the bucket. This preserves the structural win while keeping visible combo expressions separate for materialization. For concrete-equivalent accounting, forwarding residue probably cannot be pooled only by structural node, because that would mix rounding state across different visible combo expressions that current concrete search would keep separate. First-pass concrete-equivalent mode should key forwarding residue by `(graphId, nodeId, payload identity, edgeIndex)` or otherwise prove a coarser residue bucket is equivalent. Factorized accounting can revisit coarser aggregate residue later.

This is memory-for-time in the abstract, but it may be memory-neutral or even memory-positive if implemented carefully. The current concrete search pays per concrete node/frontier entry for graph arrays, node IDs, expansion cache entries, frontier heap/storage slots, and residue arrays. Plex collapses many tiny structural nodes into fewer structural nodes with larger payload buckets. To avoid turning that into a payload-memory blowup:

- intern canonical choice lists / choose-set identities instead of copying the same alternatives everywhere;
- merge identical payload expressions inside a bucket by expression identity plus accounting mode;
- store fixed selections and choice groups as small immutable refs where practical, not large reconstructed objects;
- keep cached keys such as `PackedCombo` choice-list keys experimental until profiling shows lookup cost dominates payload memory;
- track diagnostics for structural node count, payload count, average/max payloads per node, and estimated payload memory.

The first prototype should report whether memory actually moved from “many structural nodes” to “few buckets with payload refs” or whether payload duplication became the new bottleneck.

The aggregate node should stay lean. It does not need to copy pool-entry data the engine can derive from the active `RegistryKernel`. It mainly needs the exact semantic alternatives selected at that edge, plus accounting state. In practice that means:

- structural state: `exclusionMask`, `currentLevel`, `count`, graph/pool identity, book mode, and any supported policy mode;
- fixed concrete selections that are not part of an aggregate choice;
- aggregate choice groups, each with:
  - exact alternatives as `(enchantId, rank)` pairs, or equivalently `PackedEnchant` values;
  - optional cached derived data only for hot-path speed, such as combo index, weight, or exclusion mask;
  - mass / numerator / residue state needed by the selected accounting mode;
- dependency shape between choice groups: independent product when proven safe, otherwise a small choice DAG / joint distribution.

The important distinction is not “store full pool entries” versus “store names”; it is “store the exact alternatives that were eligible at that edge.” Internally this can just be the existing `PackedEnchant` value (`enchantId << ENCHANT_SHIFT | rank`) for each alternative. The registry already has `enchantToIndex` / `indexToEnchant` for the dense combo byte indices used by `PackedCombo`, so `comboIndex` can be derived from `PackedEnchant` unless profiling says to cache it. A shorthand such as `damage = [Sharpness IV, Smite IV, Bane IV]` is enough for human docs because the implementation form is `damage = [packedSharpnessIV, packedSmiteIV, packedBaneIV]`. A vague category like “damage type” is not enough unless it has already been resolved to that exact packed alternative list for the current edge.

Multiple aggregate choice groups can be modeled as a product of independent splits when each choice group reaches the same future state regardless of which member was chosen. Conceptually:

```text
mass(combo with damage + utility)
  -> split by damage alternatives using damage-group weights
  -> split by utility alternatives using utility-group weights
  -> emit every concrete product combination
```

So an internal shorthand like:

```text
Unbreaking III + (Sharpness IV | Smite IV | Bane IV) + (Fortune III | Silk Touch I)
```

can materialize as the matrix of all damage × tool-special alternatives, with each final combo receiving the product of the conditional weight shares for the choices that still need to be made.

For current registry/search semantics, future dependence is represented by exclusion masks: selecting an enchantment only changes future eligibility by excluding itself and its conflicts. Therefore cross-list contamination should not occur if plex lists are built from exact edge-local alternatives with identical `blocksBitset` / exclusion behavior. If a member of one apparent list conflicts with only part of another apparent list, the masks will differ and the alternatives must not be split into independent plex lists; they either remain concrete or become part of a larger joint component.

The set of pending choice groups also needs a canonical, order-insensitive identity. `[[protection type], [damage type]]` and `[[damage type], [protection type]]` are the same unresolved product if every inner choice list matches exactly. The simple canonical form should be:

1. sort each choice list by packed enchant key;
2. sort the choice lists lexicographically by their sorted elements;
3. compare choose-sets by outer length, then inner list length, then element equality.

Use the full lexicographic comparator for the outer choice lists. In practice the first element usually decides the order, so the robust comparator costs effectively nothing at the expected sizes. A quick audit of current conflict-rule boundary versions (`1.0`, `1.13`, `1.14`, `1.14.3`, `1.21`) shows the active conflict graph is partitioned into disjoint components with no duplicate component membership; the largest active component is the 1.21 damage component of size 6. Keep that as a registry invariant/assertion and optimization assumption, not as the correctness requirement for ordering. If a derived denominator / total weight is not fully determined by the packed enchant keys and active kernel, include it in the list signature or comparison key.

That makes equivalent pending products cheap to recognize regardless of traversal order, while still rejecting near-matches where one level/item edge has a different rank, missing alternative, or different weight denominator.

The current combo utilities provide canonical `PackedCombo` equality for concrete chosen enchantments, but plex choice lists should have their own exact helper rather than abusing `PackedCombo` as a set key. `PackedCombo` is capped by concrete combo slots and uses dense combo indices; a choice list is a set of possible alternatives and may need different limits. Add a small utility such as:

```ts
function samePackedEnchantList(a: readonly PackedEnchant[], b: readonly PackedEnchant[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
```

The helper assumes canonical sorted lists. Builders should sort once or maintain sorted insertion as alternatives are added. With list sizes expected to be tiny, sorted insertion plus length/equality comparison is reliable and effectively free.

There is also a possible `PackedCombo` cached-key path for choice-list identity, but it should be treated as an experimental optimization idea, not a first-pass plan. Current registry conflict components top out at 6 enchantments: the modern damage component (`Sharpness`, `Smite`, `Bane of Arthropods`, `Impaling`, `Density`, `Breach`). That matches `PACKING_CONSTANTS.MAX_COMBO_SLOTS = 6`, so a choice list can be encoded as a `PackedCombo` of its dense `comboIndex` values when it fits. However, this is only faster if the key is already available or reused many times. Constructing the key just to compare two tiny sorted lists is likely slower than a direct length + element comparison, and storing both the semantic list and a packed key adds memory load.

First-pass comparison strategy:

- semantic representation and sort source: exact canonical sorted `PackedEnchant[]` alternatives;
- default equality: direct length + element comparison of canonical lists;
- no cached `PackedCombo` key unless profiling later shows repeated choice-list lookup/dedupe is hot.

Experimental option: cache `PackedCombo` or interned numeric list ids for map lookup / dedupe if benchmarks prove the extra memory and complexity are worth it. Do not let cached keys and list fallback become competing sort domains. Outer choose-set ordering should always be derived from the canonical `PackedEnchant[]` alternatives, or from a single interned list id created from those alternatives. The cached key may accelerate repeated equality/hash lookup after canonicalization, but it should not decide where the list sits relative to fallback lists. If memory pressure later motivates dropping the alternatives array for packed-key lists, the implementation still needs a representation-independent comparator/sort key generated from the same canonical alternatives before dropping them.

That product model is safe while the groups are truly independent in the compressed state. If future mechanics ever add dependencies that are not expressible as conflicts/exclusion masks, or if rounding residue creates a correlation that must be preserved for concrete-equivalent accounting, the payload must represent a choice DAG / joint distribution instead of separate independent lists. The plex executor should therefore start with the product model for exact identical-exclusion groups and keep the representation capable of falling back to a DAG when independence is not proven.

For books, this could compress a large amount of structural work. A book can pass through several independent-looking conflict groups, such as damage type, armor protection type, fortune/silk-touch, trident loyalty/riptide/channeling, and crossbow multishot/piercing. The plex graph may shrink dramatically because the future state only sees the groups as excluded. The result materializer may still have to expand a large matrix of concrete combinations, so this can move complexity from search to materialization rather than delete it. That is still useful if product flows usually need bounded/top summaries or if materialization can be capped, streamed, or memoized separately.

Delayed division is promising for precision. If aggregate branches carry exact numerator/denominator factors and quantize only when concrete results are materialized, active edge-split residue may shrink because the engine avoids flooring every concrete branch at every intermediate step. That would be a deliberate factorized accounting mode, not current concrete-equivalent accounting. It needs explicit invariants and parity/near-parity comparisons because it changes where fixed-point rounding occurs.

First safe implementation slices:

1. Add `blocksBitset` / exclusion-mask metadata to `SearchPoolEntry` and assert conflict symmetry or compute symmetric closure.
2. Add measurement-only diagnostics that group pending nodes by prefix-independent future identity.
3. Add canonical plex choice-list helpers: sorted `PackedEnchant[]`, lexicographic choose-set ordering, direct equality, and optional diagnostics for conflict-component invariants.
4. Add an opt-in `PlexGraph` keyed by `(exclusionMask, currentLevel, count)` without touching the default concrete graph.
5. Add an opt-in plex run path with structural frontier buckets, payload sets, and resolved-plex storage.
6. Emit materialized compatibility views for `SearchResult.snapshot.results`, `pendingEntries`, and worker-facing projection while keeping internal pending/resolved state compressed.
7. Initially disable plex mode when `targetClueId` is present, `useSuffixMerging` is true, or book random-removal handling would require unresolved aggregate redistribution.
8. Prove degenerate concrete parity first, then real choice-group parity, then benchmark memory/time before considering default enablement.
9. Keep public/default search behavior unchanged until exhaustive parity and benchmark evidence justify enabling it.

Implementation kickoff checklist:

- Start with diagnostics and helpers, not the full engine swap.
- Preserve the intended supported API: `getStats`, `searchToCheckpoint`, `searchSequentialCheckpoints`, read-only `engine.registry`, cache controls, and worker-compatible snapshots.
- Treat `SearchRun` / `SearchGraph` exports as advanced/incidental until the API boundary is documented elsewhere.
- Do not materialize resolved plex eagerly; emit materialized views without destroying internal plex state.
- Do not add cached `PackedCombo` choice-list keys in v1 unless profiling proves direct sorted-list equality is hot.
- Keep one amended planning commit until implementation starts; implementation commits should be small and reviewable.

Correctness guardrails:

- Clue mode depends on actual combo contents and target compatibility; disabled initially.
- Book `removeAdditional` must run over actual materialized combos or over an aggregate expression with proven-equivalent expansion semantics, not over plex nodes alone.
- Weighted split residue may need to be keyed by aggregate-choice alternative plus structural edge; pooling residue too early can change exact unit allocation.
- Existing suffix merging includes visible combo identity and should not be combined with plex mode until redesigned.
- Public snapshots currently expose one combo per pending node; plex mode must either materialize compatible pending entries or keep aggregate-only state internal.

Testing should start with non-book conflict-heavy cases such as sword, spear, mace, and armor protection groups. Compare plex opt-in against current exhaustive results for `mass`, expanded concrete `results`, pending mass, active residue, and conservation to `PRECISION` before treating wall-clock speedups as meaningful. Books should be tested separately because aggregate combo expansion, `removeAdditional`, and result-tail volume may dominate.

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

## Maintenance Notes

- Keep this document current when search identity, checkpoint semantics, mass accounting, or caching behavior changes.
- Keep `ARCHITECTURE.md` as the shorter map and link here for deep V7 reasoning.
- Keep archived inventory docs clearly marked as non-canonical research snapshots; do not try to maintain them as function-by-function references.
- Treat snapshot fixture updates as separate reviewable commits, especially for books.

## References / Related Docs

- `ARCHITECTURE.md` — V7 architecture map.
- `MASS_HANDLING.md` — current V7 mass accounting and residue rules.
- `docs/search-function-inventory.md` — archived rename research snapshot, not canonical current behavior.
- `docs/function-behavior-inventory.md` — archived function-reading research snapshot, not canonical current behavior.
- Existing snapshot fixtures under `tests/snapshots/`.

## Owner / Maintainer

Jonathan Braver / V7 engine maintainers.

## Last Updated

2026-05-18
