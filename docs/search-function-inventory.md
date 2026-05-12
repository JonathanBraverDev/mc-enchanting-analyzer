# Search Rename Plan, Flow Map, and Function Inventory

## Common Description

This document is the working rename-planning artifact for the shared-search rewrite. It maps the repo-wide request/data flow, defines the intended vocabulary layers, inventories the key functions in the registry/search/engine path, and records rename candidates for terms that drifted, became overloaded, or now dilute architectural boundaries.

The main conclusion was that the former `SearchRegistryContext` should become **`RegistryKernel`**. That rename has landed. The object is not a generic context and not a search service. It is the request-scoped executable slice compiled from the resolved registry: it builds graph-ready modified-level pools and stable pool signatures so shared search graphs can safely reuse structure.

## Table of Contents

- [Research Metadata](#research-metadata)
- [Executive Summary](#executive-summary)
- [Repo-Wide Flow Graph](#repo-wide-flow-graph)
- [Layer Map](#layer-map)
- [Vocabulary Boundary](#vocabulary-boundary)
- [Vocabulary Audit](#vocabulary-audit)
- [Search-Term Saturation Audit](#search-term-saturation-audit)
- [Rename Candidates](#rename-candidates)
- [Registry Kernel Fit](#registry-kernel-fit)
- [Function Inventory](#function-inventory)
  - [Registry / Kernel Candidate](#registry--kernel-candidate)
  - [Search Graph](#search-graph)
  - [Search Run](#search-run)
  - [Search State Cache](#search-state-cache)
  - [Search Execution Service](#search-execution-service)
  - [Core Registry Functions](#core-registry-functions)
  - [Engine Boundary](#engine-boundary)
  - [Engine Cache](#engine-cache)
  - [Test Helpers](#test-helpers)
- [Recommended Rename Order](#recommended-rename-order)
- [Open Questions](#open-questions)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Research Metadata

- Research Date: 2026-05-11
- Researcher: Thing 2
- Ticket: none
- Status: Working rename plan
- Sources:
  - `src/ui/**`
  - `src/worker/**`
  - `src/lib/engine/**`
  - `src/lib/search/**`
  - `src/lib/services/**`
  - `src/lib/core/**`
  - `src/lib/types/**`
  - `tests/unit/search/**`

## Executive Summary

The current architecture is mostly clean, but naming drift is visible around the registry/search boundary and around UI/worker progression terms.

Strong names that should be preserved:

- `RegistryState` — authoritative resolved rules/catalog.
- `SearchGraph` — reusable structure-only state space; no probability mass.
- `SearchRun` — probability mass and accounting moving through graphs.
- `SearchExecutionService` — engine-facing orchestration/caching/checkpoint boundary.
- `SnapshotService` — converts engine snapshots to UI view models.

Weak or overloaded names:

- Former `SearchRegistryContext` — now fixed as `RegistryKernel`.
- `Context` — vague and prone to becoming a junk drawer.
- `refinement` — used for checkpoint presets, UI lifecycle, and chart pass progression.
- `top` — mixes selected-XP lane, top-N combo ranking, top worker, and top run view.
- `target` — mixes user requirement targets with checkpoint stop-control `targetClassifiedMass`.
- `project` / `projection` — sometimes means UI projection, sometimes re-projecting cached search with new targets.

Primary recommendation:

- Keep the completed `RegistryKernel` rename and use `kernel` for local variables that hold this object.
- Keep `SearchGraph`, `SearchRun`, `SearchExecutionService`, and `SearchStateCache` for now.
- Treat broader UI/protocol terms as a second pass after the kernel rename, because they touch more user-facing and worker protocol concepts.

## Repo-Wide Flow Graph

```text
UI controls / page state
  ParamsView + AppController
  src/ui/views/ParamsView.ts
  src/ui/index.ts

    ├─ metadata-only lookups for dropdowns, constraints, clue options, target options
    │    UiMetadataService
    │    src/lib/services/UiMetadataService.ts
    │    -> RegistryFactory / core/registry / ModifiedLevelDistributionService
    │
    └─ refinement orchestration
         RefinementService
         src/ui/refinement.ts
         -> WorkerClient.startTopRun / startChartRun / projectTopRun
            src/ui/worker-client.ts
         -> top worker + chart worker
```

```text
top worker path
  src/worker/top-worker.ts
  -> WorkerShell initializes EnchantEngine per version
     src/worker/WorkerShell.ts
  -> EnchantEngine.searchSequentialCheckpoints(...)
     src/lib/engine/index.ts
  -> SearchExecutionService.getRun/createRun
     src/lib/search/SearchExecutionService.ts
  -> RegistryKernel today / RegistryKernel desired
     src/lib/search/registry/RegistryKernel.ts
  -> SearchRun.seedXp(xp) + searchToCheckpointAsync(...)
     src/lib/search/SearchRun.ts
  -> SearchStateCache.getOrCreateRun / getOrCreateGraph
     src/lib/search/SearchStateCache.ts
  -> SearchGraph for pool-signature structure
     src/lib/search/SearchGraph.ts
  -> SearchRunSnapshot
  -> SnapshotService.create(snapshotType='top')
     src/lib/services/SnapshotService.ts
  -> TopRunView back to UI
     src/lib/types/views.ts
```

```text
chart worker path
  src/worker/chart-worker.ts
  -> loops refinementLevel x xp
  -> EnchantEngine.searchToCheckpoint(...)
  -> same SearchExecutionService / RegistryKernel / SearchRun / SearchGraph stack
  -> SnapshotService.create(snapshotType='chart-cell', includeCombos=false)
  -> ChartCellView back to UI
```

```text
projection / presentation after snapshot
  SnapshotService
    -> SummaryAggregationService
    -> ClueAnalysisService
    -> TargetAnalysisService
    -> TargetClueAdvisorService
    -> ClueSignalAdvisorService
  -> TopRunView / ChartCellView
  -> ResultsView + chart controllers render only
     src/ui/views/ResultsView.ts
     src/ui/results-chart-controller.ts
     src/ui/results-chart-manager.ts
```

## Layer Map

### UI Layer

Purpose: browser state, user input, display, and interaction orchestration.

Key files/classes:

- `src/ui/index.ts` — `AppController`; coordinates params, results, chart, and refinement lifecycle.
- `src/ui/views/ParamsView.ts` — DOM input state, target chips, clue/target option refresh.
- `src/ui/views/ResultsView.ts` — renders returned `TopRunView`; no search.
- `src/ui/results-chart-controller.ts` and `src/ui/results-chart-manager.ts` — chart rendering and interaction.

Naming notes:

- UI should prefer words like `View`, `Controller`, `Manager`, and `Options`.
- Avoid leaking search-internal terms into UI unless the UI genuinely presents them.

### UI-Facing Metadata / Options Layer

Purpose: answer “what can the user pick?” without running the main search path.

Key files/classes:

- `src/lib/services/UiMetadataService.ts`
- `src/lib/core/factory.ts`
- `src/lib/core/registry.ts`

Naming notes:

- `UiMetadataService` is acceptable but undersells that it computes dynamic clue/target options via registry and distribution lookups.
- Possible future names: `UiOptionsService`, `UiRegistryQueryService`, or `InputOptionsService`.
- Do not mix this layer with `SearchExecutionService`; it is read/query support for forms.

### Worker Transport Layer

Purpose: browser/worker protocol, run IDs, supersession, abort/terminal/error messaging.

Key files/classes:

- `src/ui/worker-client.ts` — browser-side protocol wrapper.
- `src/worker/WorkerShell.ts` — shared worker runtime, active run handling, abort/supersede, terminal/error messages.
- `src/worker/top-worker.ts` — selected-XP lane; streams checkpoint snapshots.
- `src/worker/chart-worker.ts` — XP sweep lane; loops refinement levels and XP cells.
- `src/lib/types/protocol.ts` — worker message/view protocol types.

Naming notes:

- `top` is serviceable but broad. It currently means selected-XP/top-results lane.
- `projectTopRun` / `topRunProject` is slightly opaque: it means “re-project cached top search results for changed targets/advisor mode.”
- Future candidate: `reprojectTopRun` or `projectCachedTopRun`.

### Engine Boundary Layer

Purpose: stable business API above shared-search internals.

Key files/classes:

- `src/lib/engine/index.ts` — `EnchantEngine`
- Public-ish methods:
  - `searchToCheckpoint`
  - `searchSequentialCheckpoints`
  - `getModifiedLevelDist`
  - `getAvailablePool`

Naming notes:

- `EnchantEngine` remains the right boundary name.
- Engine methods can keep `searchToCheckpoint` / `searchSequentialCheckpoints` because the caller thinks in checkpoint semantics.
- Engine should not expose `RegistryKernel` unless consumers need raw search internals.

### Registry / Core Layer

Purpose: authoritative resolved rule queries and versioned registry construction.

Key files/classes:

- `src/lib/core/factory.ts` — `RegistryFactory`; builds versioned `RegistryState`.
- `src/lib/core/registry.ts` — item/material/enchant lookup and eligibility helpers.
- `src/lib/types/domain.ts` — registry/domain shape.

Naming notes:

- `RegistryState` is strong and should remain the full resolved catalog/rules object.
- `RegistryKernel` should mean a compact request-scoped operational slice derived from `RegistryState`.
- Keep `RegistryFactory` and `RegistryState` distinct from `RegistryKernel`.

### Shared Search Internals

Purpose: shared structural search and probability-mass execution.

Key files/classes:

- `src/lib/search/registry/RegistryKernel.ts` — desired `RegistryKernel`; request-scoped item/material slice of registry; builds immutable pools and signatures.
- `src/lib/search/SearchGraph.ts` — structure-only graph; no probability mass.
- `src/lib/search/SearchRun.ts` — mass-bearing executor, frontier, residue accounting, clue pruning, resolved results.
- `src/lib/search/SearchStateCache.ts` — structural graph cache plus resumable XP-cell run cache.
- `src/lib/search/SearchExecutionService.ts` — engine-facing orchestration around cached runs/checkpoints/results.

Naming notes:

- This layer should maintain strict vocabulary:
  - `Kernel` for registry-derived request slice.
  - `Pool` for modified-level eligible entries.
  - `Graph` for reusable structure.
  - `Run` for mass/accounting state.
  - `ExecutionService` for orchestration.

### Projection / Services Layer

Purpose: convert search snapshots and combo data into public stats or UI view models.

Key files/classes:

- `src/lib/services/SnapshotService.ts` — `SearchRunSnapshot` -> `TopRunView` / `ChartCellView`.
- `src/lib/services/SummaryAggregationService.ts` — shared scan over resolved combos + pending frontier.
- `src/lib/services/SummaryService.ts` — `EnchantStats` formatter used by the public `getStats(...)` convenience API and explicit search-result summarization.
- `src/lib/services/TargetAnalysisService.ts` — target filtering/projection over combos and pending entries.
- `src/lib/services/TargetClueAdvisorService.ts` — clue advisor projection for target requirements.
- `src/lib/services/ClueSignalAdvisorService.ts` — level/clue signal advisor summaries.
- `src/lib/services/TopComboSortService.ts` — display sort.

Naming notes:

- `SnapshotService` is strong enough.
- `SummaryAggregationService` is accurate but slightly long; not urgent.
- `TargetAnalysisService` is okay, but keep “target” distinct from search stop targets.

## Vocabulary Boundary

The vocabulary risk is dilution: if every layer gets named `Search*`, the boundaries become harder to reason about.

Recommended meanings:

| Term | Meaning |
|---|---|
| Registry | Authoritative resolved rules/catalog: enchantments, weights, conflicts, item/material eligibility, version behavior. |
| RegistryState | Full resolved registry data for a selectable version or mutated registry. |
| RegistryFactory | Builder for `RegistryState`. |
| RegistryKernel | Compact executable slice compiled from registry data for one item/material request. |
| Pool | Eligible enchantment set at one modified level. |
| PoolSignature | Stable structural fingerprint used for graph equivalence/reuse. |
| Graph | Reusable structural state space; no probability mass. |
| Run | Probability mass and accounting moving through graphs. |
| Frontier | Pending weighted `(graph, node)` work queue inside a run. |
| Snapshot | Materialized state export from a run or view projection. |
| Execution Service | Engine boundary that creates/resumes runs and converts snapshots to public results. |
| Refinement | User/product checkpoint progression, not the low-level search algorithm itself. |
| Projection | Conversion/re-filtering of existing search state into UI/public shapes. |

## Vocabulary Audit

### Strong Terms

- `RegistryState`
  - Meaning: authoritative resolved rules/catalog.
  - Keep.
  - References: `src/lib/types/domain.ts`, `src/lib/core/factory.ts`.

- `SearchGraph`
  - Meaning: structure-only state space.
  - Keep.
  - References: `src/lib/search/SearchGraph.ts`.

- `SearchRun`
  - Meaning: mass-bearing execution state.
  - Keep.
  - References: `src/lib/search/SearchRun.ts`.

- `SearchExecutionService`
  - Meaning: engine-facing orchestration/boundary layer.
  - Keep.
  - References: `src/lib/search/SearchExecutionService.ts`.

- `SnapshotService`
  - Meaning: projection to UI snapshots/views.
  - Keep.
  - References: `src/lib/services/SnapshotService.ts`.

### Overloaded / Muddy Terms

- `RegistryKernel`
  - Problem: combines “search” and “registry” while using vague `Context`.
  - Actual responsibility: request-scoped compiled registry kernel.
  - Rename to `RegistryKernel`.

- `context` variables referring to `RegistryKernel`
  - Problem: hides that callers are passing a kernel-like object.
  - Rename to `kernel` when the class becomes `RegistryKernel`.

- `refinement`
  - Problem: used for checkpoint preset names, UI streaming lifecycle, and chart passes.
  - Current status: tolerable but broad.
  - Possible future split:
    - `checkpointLevel` for coarse/standard/deep/ultra stop policy.
    - `refinement` for user-visible progressive improvement.
    - `chartPass` for chart sweep loop if needed.

- `top`
  - Problem: means selected XP lane, top-N ranking, worker name, and view name.
  - Current status: understandable but saturated.
  - Possible future alternatives:
    - `selectedLevelRun` for the lane.
    - `topCombos` for ranked result list.
    - `TopRunView` may remain if UI vocabulary expects “top results.”

- `target`
  - Problem: user target requirements and stop-control `targetClassifiedMass` share the word.
  - Candidate: rename `targetClassifiedMass` to `minClassifiedMass` or `classifiedMassGoal` if this becomes a recurring confusion.
  - Do not rename user `TargetRequirement` terms unless there is a separate target-model pass.

- `project` / `projection`
  - Problem: used both for UI projection and “re-project cached top run with different targets.”
  - Candidate: `projectTopRun` -> `reprojectTopRun` / `projectCachedTopRun`.

- `UiMetadataService`
  - Problem: “metadata” undersells dynamic query work.
  - Candidate: `UiOptionsService` / `InputOptionsService` / `UiRegistryQueryService`.
  - Not urgent.


## Search-Term Saturation Audit

A source-only identifier scan shows that `Search/search` is common but not uniformly meaningless. It is concentrated in the actual shared-search layer and engine boundary.

Counts from `src/**/*.ts`:

| Term | Identifier occurrences | Source files | Read |
|---|---:|---:|---|
| `Search` | 310 | 19 | High, but mostly concentrated in search internals/types. |
| `search` | 96 | 22 | Mostly method/property names like `searchToCheckpoint`, `searchMs`, and local variables. |
| `Registry` | 202 | 33 | Broad but expected; registry is a real cross-layer domain concept. |
| `Context` | 32 | 8 | Suspicious because it usually hides a more precise role. |
| `Service` | 170 | 24 | Common architectural suffix; acceptable where it marks orchestration/projection services. |
| `Run` | 240 | 22 | High but meaningful in worker/search lifecycle. |
| `Graph` | 126 | 5 | Concentrated and precise. |
| `Refinement` | 72 | 11 | Product concept, but broad. Watch for drift. |
| `Target` | 217 | 15 | Legitimate user feature, but overloaded with stop-control `targetClassifiedMass`. |
| `Projection` | 3 | 1 | Not saturated as an identifier; concept appears mostly in prose/comments. |

Top `Search/search` identifiers in source:

| Identifier | Count | Classification | Recommendation |
|---|---:|---|---|
| `search` | 67 | Generic local/property/comment term | Accept where it means the operation; avoid for layer names. |
| `SearchGraphNodeId` | 38 | Precise structural graph term | Keep. |
| `SearchRun` | 29 | Precise mass-bearing execution term | Keep. |
| `SearchGraph` | 18 | Precise structure-only term | Keep. |
| Former `SearchRegistryContext` | 18 before rename | Mixed/vague | Fixed as `RegistryKernel`. |
| `SearchPool` | 15 | Mostly acceptable graph-ready pool term | Keep for now; revisit after kernel rename. |
| `SearchResult` | 14 | Engine boundary result type | Accept; public-ish result of search APIs. |
| `SearchRunSnapshot` | 12 | Precise snapshot of a run | Keep. |
| `ClueSearchPolicy` | 12 | Search-specific pruning policy | Keep. |
| `getSearchCheckpointForRefinement` | 11 | Boundary helper | Accept, though `getCheckpointForRefinement` may be enough later. |
| `getDefaultStatsCheckpoint` | 2 | Boundary helper | Keep as the single default stats checkpoint used by `getStats(...)` and simple-result tests. |
| `SearchPoolSignature` | 11 | Precise structural identity for graph reuse | Keep for now. |
| `SearchGraphExpansion` | 10 | Precise graph expansion type | Keep. |
| `SearchStateCache` | 7 | Slightly broad but accurate enough | Keep. |
| `SearchExecutionService` | 6 | Engine-facing orchestration | Keep. |

Conclusion: `Search` is not over-saturated everywhere, but it was overused at the registry boundary. The bad pattern was not the volume alone; it was when `Search` combined with another layer word and a vague suffix, as in the former `SearchRegistryContext`. That name blurred three concepts at once:

- `Search` as consumer layer.
- `Registry` as source layer.
- `Context` as non-specific container.

The names that remain strong use `Search` to identify a concrete search-internal artifact:

- `SearchGraph`: structure.
- `SearchRun`: mass-bearing execution.
- `SearchRunSnapshot`: materialized run state.
- `SearchExecutionService`: orchestration boundary for executing search requests.

Rule of thumb for the rename pass:

> Keep `Search*` only when the thing is primarily a search artifact or API boundary. Drop `Search` when the thing is primarily registry-derived, UI-facing, or generic orchestration.

## Rename Candidates

### Priority 1: Registry Kernel Rename

| Completed change | Current form | Why |
|---|---|---|
| `SearchRegistryContext` | `RegistryKernel` | It is a compact executable registry slice, not a generic context. |
| `SearchRegistryContextRequest` | `RegistryKernelRequest` | Follows class rename. |
| `src/lib/search/registry/SearchRegistryContext.ts` | `src/lib/search/registry/RegistryKernel.ts` | File matches class. |
| local variable `context` for this object | `kernel` | Makes downstream code read as graph/run consuming a registry kernel. |
| error text | `RegistryKernel supports...` | Runtime diagnostics align with current type. |
| `search-registry-context.test.ts` | `registry-kernel.test.ts` | Test describes concept under test. |

Recommended JSDoc:

```ts
/**
 * Request-scoped executable slice of the resolved registry.
 *
 * Builds immutable modified-level pools and stable pool signatures so shared
 * search graphs can safely reuse structure across equivalent levels.
 */
export class RegistryKernel { ... }
```

### Priority 2: Kernel-Adjacent Pool Terms

Current `SearchPool*` terms are probably acceptable because the pools are graph/search-ready projections, not raw registry item pools.

Keep for now:

- `SearchPoolSignature`
- `SearchPoolEntry`
- `SearchPool`
- `SearchPoolGroup`

Possible later alternatives:

| Current | Possible | Tradeoff |
|---|---|---|
| `SearchPool` | `KernelPool` | Emphasizes registry-kernel ownership, but less intuitive. |
| `SearchPoolEntry` | `PoolEntry` | Cleaner inside module, but may conflict with raw registry pool vocabulary. |
| `SearchPoolSignature` | `PoolSignature` | Cleaner if scoped by `RegistryKernel.ts`; may be too generic when exported. |

Recommendation: keep `SearchPool*` until after the `RegistryKernel` rename lands. The prefix is useful because `core/registry.ts` already has raw eligible pools.

### Registry Runtime Effective Rank Ranges

`RegistryFactory` now compiles declared rank ranges into runtime effective rank intervals. Existing registry callers still use the previous raw-range paths; the compiled projection exists so the effective ranges can be tested before migrating callers.

Each enchantment exposes effective rank intervals where lower ranks have already been shadowed by higher ranks. For integer modified levels:

- If rank I is `[1, 500]` and rank II is `[6, 600]`, then rank I's effective interval is `[1, 5]`.
- Rank I can never appear at modified level `6+`, because rank II is eligible and higher.
- The general rule is: `effective(rank) = declared(rank) - union(declared(higher ranks))`.
- For current Minecraft-style contiguous monotonic ranges this usually collapses to truncating the lower rank's max to `nextHigherMin - 1`, but the safer implementation should subtract higher-rank intervals rather than assume perfect shape.

Implementation notes:

- Effective rank ranges are computed during registry factory/build time.
- Empty declared ranges such as Quick Charge III `52-50` are kept in source data and dense packed-rank indexing, but dropped from the effective interval projection.
- Original declared ranges stay in `resolvedRegistry` for docs/display/debugging so the source data still matches Minecraft tables.
- Next migration step: move `getCandidatePool`, clue validation, and target packing/options from raw declared ranks to the compiled effective intervals.

### Priority 3: Worker Projection Vocabulary

| Current | Possible | Why |
|---|---|---|
| `projectTopRun` | `reprojectTopRun` | This is not initial projection; it reuses cached search results and re-projects for changed targets/advisor mode. |
| message type `topRunProject` | `topRunReproject` | Aligns protocol with behavior. |
| `CachedTopRun` | keep | It is accurate. |

Recommendation: defer. This is a worker protocol rename and should be done separately with focused tests.

### Priority 4: UI Options Service

| Current | Possible | Why |
|---|---|---|
| `UiMetadataService` | `UiOptionsService` | Most calls answer dropdown/target/clue options, not static metadata. |
| `UiMetadataService` | `InputOptionsService` | Stronger if we want it tied to input controls rather than UI broadly. |

Recommendation: defer. It is outside the current shared-search naming pass.

### Priority 5: Stop-Control Target Term

| Current | Possible | Why |
|---|---|---|
| `targetClassifiedMass` | `minClassifiedMass` | Describes a stop threshold without colliding with user target requirements. |
| `targetClassifiedMass` | `classifiedMassGoal` | Clearer as a goal, but slightly wordy. |

Recommendation: defer unless checkpoint naming gets a dedicated cleanup. It touches request types and validation.

## Registry Kernel Fit

The kernel was introduced for the shared-search rewrite because the new search model needs a stable equivalence layer between raw registry data and reusable graph structure.

Old independent-level search could repeatedly ask:

> What enchantments are eligible at modified level L?

Shared search has to ask:

> Can modified levels L1, L2, and L3 safely share one structural graph?

The kernel solves that question by:

1. Capturing request constants:
   - `registry`
   - `version`
   - `item`
   - `material`
   - `enchantability`
   - `multiEnchantBooks`
2. Producing graph-ready pools per modified level:
   - packed enchant
   - enchant ID and rank
   - weight
   - combo index
   - ID bit
   - conflict bitset
3. Computing stable pool signatures.
4. Grouping structurally equivalent levels.
5. Keeping `SearchGraph` from querying raw registry functions directly.
6. Keeping `SearchRun` from repeatedly decoding packed enchants and conflicts.

This is why `RegistryKernel` is a strong term: it is the compact operational core derived from the registry for one request.

## Function Inventory

### Registry / Kernel Candidate

Current file: `src/lib/search/registry/RegistryKernel.ts`

| Location | Symbol | Kind | Responsibility | Tags |
|---|---|---|---|---|
| `src/lib/search/registry/RegistryKernel.ts:58` | `RegistryKernel.constructor` | constructor | Captures request-scoped registry/item/material state and precomputes enchantability plus book-mode flags. | registry-derived, pool-building, graph-structure |
| `src/lib/search/registry/RegistryKernel.ts:67` | `getPool` | class method | Builds or returns a cached immutable modified-level pool with projected entries, total weight, and stable structural signature. | registry-derived, pool-building, graph-structure |
| `src/lib/search/registry/RegistryKernel.ts:88` | `groupLevelsByPoolSignature` | class method | Groups modified levels whose projected pools have identical signatures so they can reuse one structural graph. | registry-derived, pool-building, graph-structure |
| `src/lib/search/registry/RegistryKernel.ts:108` | `toPoolEntry` | private method | Converts one packed enchant into the precomputed graph-ready entry form, including weight, combo index, ID bit, and conflict bitset. | registry-derived, pool-building, graph-structure |
| `src/lib/search/registry/RegistryKernel.ts:129` | `createPoolSignature` | private method | Produces the stable fingerprint that represents the structural eligibility/conflict/weight shape of a pool. | registry-derived, pool-building, graph-structure |
| `src/lib/search/registry/RegistryKernel.ts:146` | `fnv1a64` | local helper | Hashes the pool-signature source string into a compact deterministic 64-bit hex fingerprint. | graph-structure |

Interpretation: this object is a request-scoped registry kernel. It is the boundary object that turns resolved registry data into pool/signature primitives that graph search can use safely.

### Search Graph

File: `src/lib/search/SearchGraph.ts`

| Location | Symbol | Kind | Responsibility | Tags |
|---|---|---|---|---|
| `src/lib/search/SearchGraph.ts:21` | `NumericGraphNodeIndex.constructor` | constructor | Initializes the dense numeric hash index used for fast graph node lookup. | graph-structure |
| `src/lib/search/SearchGraph.ts:31` | `NumericGraphNodeIndex.get` | class method | Looks up an existing node ID by numeric packed key. | graph-structure |
| `src/lib/search/SearchGraph.ts:45` | `NumericGraphNodeIndex.set` | class method | Inserts or updates a node ID for a numeric key, growing storage when needed. | graph-structure |
| `src/lib/search/SearchGraph.ts:50` | `NumericGraphNodeIndex.insert` | private method | Performs open-addressed insertion/update into the numeric node table. | graph-structure |
| `src/lib/search/SearchGraph.ts:67` | `NumericGraphNodeIndex.grow` | private method | Resizes and rehashes the numeric node index when load factor is exceeded. | graph-structure |
| `src/lib/search/SearchGraph.ts:86` | `NumericGraphNodeIndex.hash` | private method | Computes a mixed 32-bit hash for the packed numeric node key. | graph-structure |
| `src/lib/search/SearchGraph.ts:97` | `NumericGraphNodeIndex.nextPowerOfTwo` | private method | Rounds requested hash-table capacity up to a power of two. | graph-structure |
| `src/lib/search/SearchGraph.ts:164` | `SearchGraph.constructor` | constructor | Creates a structural graph for one pool signature and records cache-key dimensions that define reuse. | graph-structure, registry-derived |
| `src/lib/search/SearchGraph.ts:180` | `SearchGraph.size` | getter | Reports how many structural nodes have been materialized. | graph-structure |
| `src/lib/search/SearchGraph.ts:185` | `getRootNode` | class method | Returns or creates the root structural node for a specific initial modified level. | graph-structure |
| `src/lib/search/SearchGraph.ts:190` | `getNode` | class method | Returns a structural metadata snapshot for a node ID. | graph-structure |
| `src/lib/search/SearchGraph.ts:201` | `getNodeCombo` | class method | Returns the packed combo represented by a node. | graph-structure |
| `src/lib/search/SearchGraph.ts:206` | `getNodeCount` | class method | Returns how many enchants have been selected along a node path. | graph-structure |
| `src/lib/search/SearchGraph.ts:212` | `getExpansion` | class method | Returns a cached outgoing expansion for a node, lazily building it if needed. | graph-structure, run-execution |
| `src/lib/search/SearchGraph.ts:223` | `buildRootExpansion` | private method | Builds first-step expansion from a root node into single-enchant children weighted by the current pool. | graph-structure, pool-building |
| `src/lib/search/SearchGraph.ts:242` | `buildSearchExpansion` | private method | Builds continuation expansion for a non-root node by filtering selected/conflicting enchants and halving continuation level. | graph-structure, run-execution |
| `src/lib/search/SearchGraph.ts:281` | `createExpansion` | private method | Packages node expansion details into the immutable expansion record used by runs. | graph-structure |
| `src/lib/search/SearchGraph.ts:300` | `getOrCreateNodeId` | private method | Reuses or allocates a canonical structural node ID for selected-mask/current-level state. | graph-structure |
| `src/lib/search/SearchGraph.ts:330` | `createNumericNodeKey` | private method | Encodes a node state into a numeric lookup key when possible. | graph-structure |
| `src/lib/search/SearchGraph.ts:335` | `createBigIntNodeKey` | private method | Encodes a node state into a bigint lookup key for large masks. | graph-structure |
| `src/lib/search/SearchGraph.ts:339` | `getTerminalReason` | private method | Decides whether a node must stop because of single-book rules or max-enchant limits. | graph-structure, registry-derived |
| `src/lib/search/SearchGraph.ts:349` | `assertNode` | private method | Guards public node accessors against unknown node IDs. | graph-structure |
| `src/lib/search/SearchGraph.ts:355` | `getBookMode` | private method | Derives the graph cache's book/item mode dimension. | registry-derived, graph-structure |

### Search Run

File: `src/lib/search/SearchRun.ts`

| Location | Symbol | Kind | Responsibility | Tags |
|---|---|---|---|---|
| `src/lib/search/SearchRun.ts:115` | `SearchRun.constructor` | constructor | Wires registry context/kernel, distribution service, graph cache, and clue target. | run-execution |
| `src/lib/search/SearchRun.ts:125` | `seedXp` | class method | Seeds modified-level probability mass into graph roots. | run-execution, registry-derived |
| `src/lib/search/SearchRun.ts:159` | `searchToCheckpoint` | class method | Synchronously advances to a checkpoint/final snapshot. | run-execution |
| `src/lib/search/SearchRun.ts:166` | `searchToCheckpointAsync` | class method | Asynchronously advances to checkpoint while yielding between scheduler chunks. | run-execution |
| `src/lib/search/SearchRun.ts:180` | `createAdvanceCriteria` | private method | Normalizes threshold, limits, mass targets, probability floor, and abort signal. | run-execution |
| `src/lib/search/SearchRun.ts:206` | `advanceUntilCheckpoint` | private method | Main best-first expansion loop until checkpoint/final stop conditions. | run-execution |
| `src/lib/search/SearchRun.ts:228` | `snapshot` | class method | Materializes current run state. | run-execution, projection |
| `src/lib/search/SearchRun.ts:245` | `expand` | private method | Dispatches root vs non-root expansion for a pending graph node. | run-execution |
| `src/lib/search/SearchRun.ts:267` | `expandRoot` | private method | Handles root-node mass distribution into one-enchant graph edges. | run-execution |
| `src/lib/search/SearchRun.ts:282` | `expandSearchNode` | private method | Handles non-root continuation and resolved-result settlement. | run-execution |
| `src/lib/search/SearchRun.ts:317` | `forwardMass` | private method | Splits mass across weighted child edges and carries/recover node-local residue. | run-execution, mass-accounting |
| `src/lib/search/SearchRun.ts:356` | `getPendingEntries` | private method | Exports pending frontier entries for snapshots and projections. | run-execution, projection |
| `src/lib/search/SearchRun.ts:371` | `getActiveResidueStats` | private method | Counts active rounding residue buckets and mass. | mass-accounting |
| `src/lib/search/SearchRun.ts:385` | `recordResidueDelta` | private method | Tracks active/recovered rounding residue changes. | mass-accounting |
| `src/lib/search/SearchRun.ts:398` | `getForwardingResidue` | private method | Reads node-local split residue. | mass-accounting |
| `src/lib/search/SearchRun.ts:403` | `setForwardingResidue` | private method | Stores node-local split residue. | mass-accounting |
| `src/lib/search/SearchRun.ts:424` | `containsTargetClue` | private method | Checks clue compatibility for a combo. | run-execution, clue |
| `src/lib/search/SearchRun.ts:428` | `recordResolved` | private method | Records resolved combo or clue-incompatible mass. | run-execution, mass-accounting |
| `src/lib/search/SearchRun.ts:480` | `pushPending` | private method | Adds or merges pending frontier mass. | run-execution |
| `src/lib/search/SearchRun.ts:486` | `graphForPool` | private method | Gets or creates the graph record for a pool signature. | run-execution, graph-structure |
| `src/lib/search/SearchRun.ts:504` | `getGraphById` | private method | Resolves a graph record by numeric graph ID. | run-execution |

#### SearchRunFrontier

| Location | Symbol | Kind | Responsibility | Tags |
|---|---|---|---|---|
| `src/lib/search/SearchRun.ts:523` | `SearchRunFrontier.size` | getter | Reports pending heap size. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:527` | `pushOrMerge` | class method | Adds mass to a `(graph, node)` frontier entry or merges with existing mass. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:545` | `peekMass` | class method | Returns largest pending mass. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:549` | `forEach` | class method | Iterates pending frontier entries. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:557` | `pop` | class method | Pops highest-mass frontier entry. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:582` | `bubbleUp` | private method | Restores heap order upward. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:600` | `sinkDown` | private method | Restores heap order downward. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:624` | `moveHeapEntry` | private method | Moves heap entry and updates index storage. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:632` | `massAt` | private method | Reads mass for heap index. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:636` | `getNodeMass` | private method | Reads mass for graph/node pair. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:640` | `ensureStorage` | private method | Ensures per-graph frontier storage capacity. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:654` | `createStorage` | private method | Allocates per-graph frontier storage. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:664` | `growStorage` | private method | Grows per-graph frontier storage. | run-execution, frontier |
| `src/lib/search/SearchRun.ts:675` | `nextPowerOfTwo` | private method | Rounds storage size. | run-execution, frontier |

### Search State Cache

File: `src/lib/search/SearchStateCache.ts`

| Location | Symbol | Kind | Responsibility | Tags |
|---|---|---|---|---|
| `src/lib/search/SearchStateCache.ts:41` | `SearchStateCache.constructor` | constructor | Creates structural graph and resumable run LRU caches. | cache |
| `src/lib/search/SearchStateCache.ts:47` | `getOrCreateGraph` | class method | Reuses or creates the structural graph for a pool signature. | cache, graph-structure |
| `src/lib/search/SearchStateCache.ts:62` | `getOrCreateRun` | class method | Reuses or creates a resumable XP-cell run. | cache, run-execution |
| `src/lib/search/SearchStateCache.ts:75` | `clearRuns` | class method | Clears run cache and run metrics. | cache |
| `src/lib/search/SearchStateCache.ts:80` | `clearAll` | class method | Clears graph/run caches and metrics. | cache |
| `src/lib/search/SearchStateCache.ts:86` | `resetMetrics` | class method | Resets graph/run hit/miss metrics. | cache, instrumentation |
| `src/lib/search/SearchStateCache.ts:91` | `getMetrics` | class method | Exports graph/run cache metrics. | cache, instrumentation |
| `src/lib/search/SearchStateCache.ts:98` | `createSearchGraphKey` | private method | Builds structural graph cache key. | cache, graph-structure |

### Search Execution Service

File: `src/lib/search/SearchExecutionService.ts`

| Location | Symbol | Kind | Responsibility | Tags |
|---|---|---|---|---|
| `src/lib/search/SearchExecutionService.ts:17` | `SearchExecutionService.constructor` | constructor | Wires distribution service and search state cache. | engine-boundary, cache |
| `src/lib/search/SearchExecutionService.ts:23` | `clearCache` | class method | Clears all search execution caches. | engine-boundary, cache |
| `src/lib/search/SearchExecutionService.ts:28` | `searchToCheckpoint` | class method | Executes one checkpoint request and returns a public search result. | engine-boundary, run-execution |
| `src/lib/search/SearchExecutionService.ts:44` | `searchSequentialCheckpoints` | class method | Executes an ordered checkpoint plan and streams completed boundaries. | engine-boundary, run-execution |
| `src/lib/search/SearchExecutionService.ts:81` | `getRun` | private method | Retrieves cached run or creates a fresh run. | engine-boundary, cache |
| `src/lib/search/SearchExecutionService.ts:87` | `createRun` | private method | Builds registry context/kernel, creates run, and seeds XP. | engine-boundary, registry-derived, run-execution |
| `src/lib/search/SearchExecutionService.ts:102` | `createRunCacheKey` | private method | Builds XP-cell run cache key. | cache |
| `src/lib/search/SearchExecutionService.ts:113` | `toSearchResult` | private method | Converts run snapshot into public `SearchResult` with instrumentation and timing. | engine-boundary, projection |
| `src/lib/search/SearchExecutionService.ts:169` | `finishTiming` | private method | Accumulates search/total timing metrics. | instrumentation |

### Core Registry Functions

File: `src/lib/core/registry.ts`

| Location | Symbol | Kind | Responsibility | Tags |
|---|---|---|---|---|
| `src/lib/core/registry.ts:12` | `getEligibleMaterials` | exported function | Returns active materials for an item. | registry |
| `src/lib/core/registry.ts:20` | `isMaterialEligible` | exported function | Checks whether item/material are available together. | registry |
| `src/lib/core/registry.ts:31` | `getEnchantName` | exported function | Resolves enchantment ID to name. | registry |
| `src/lib/core/registry.ts:43` | `getRankRoman` | exported function | Resolves rank number to Roman label. | registry |
| `src/lib/core/registry.ts:53` | `getItemId` | exported function | Resolves item name to item ID. | registry |
| `src/lib/core/registry.ts:63` | `getMaterialId` | exported function | Resolves material name to material ID. | registry |
| `src/lib/core/registry.ts:73` | `getEnchantId` | exported function | Resolves enchantment name to enchantment ID. | registry |
| `src/lib/core/registry.ts:84` | `hasConflict` | exported function | Checks conflict bitsets for two enchant IDs. | registry |
| `src/lib/core/registry.ts:94` | `isItemAvailable` | exported function | Checks whether an item is active in the registry. | registry |
| `src/lib/core/registry.ts:105` | `getItemPool` | exported function | Returns the enchantment-name pool for an item. | registry |
| `src/lib/core/registry.ts:115` | `getFullEnchantName` | exported function | Resolves packed rank ID to display name. | registry |
| `src/lib/core/registry.ts:133` | `getCandidatePool` | exported function | Returns packed eligible enchants at a modified level. | registry, pool-building |
| `src/lib/core/registry.ts:168` | `getAvailablePool` | exported function | Returns eligible pool after excluding selected/conflicting bitset. | registry, old-search utility |
| `src/lib/core/registry.ts:185` | `isEnchantmentAchievable` | exported function | Checks whether an enchant/rank can appear across modified levels. | registry |
| `src/lib/core/registry.ts:206` | `getEnchantability` | exported function | Validates item/material and returns enchantability value. | registry |
| `src/lib/core/registry.ts:218` | `sortMaterials` | local helper | Sorts materials with preferred aliases first. | registry, local-helper |

### Engine Boundary

File: `src/lib/engine/index.ts`

| Location | Symbol | Kind | Responsibility | Tags |
|---|---|---|---|---|
| `src/lib/engine/index.ts:22` | `EnchantEngine.constructor` | constructor | Wires registry, cache, distribution service, and search execution service. | engine-boundary |
| `src/lib/engine/index.ts:32` | `resetCaches` | class method | Clears engine and search execution caches. | engine-boundary, cache |
| `src/lib/engine/index.ts:38` | `getCacheMetrics` | class method | Returns current cache metrics. | engine-boundary, instrumentation |
| `src/lib/engine/index.ts:42` | `destroy` | class method | Clears engine resources. | engine-boundary |
| `src/lib/engine/index.ts:49` | `getModifiedLevelDist` | class method | Exposes modified-level distribution calculation. | engine-boundary, registry-derived |
| `src/lib/engine/index.ts:56` | `getAvailablePool` | class method | Exposes eligible-list lookup with engine cache. | engine-boundary, registry |
| `src/lib/engine/index.ts:63` | `searchSequentialCheckpoints` | class method | Validates and forwards sequential checkpoint request. | engine-boundary |
| `src/lib/engine/index.ts:70` | `searchToCheckpoint` | class method | Validates and forwards one checkpoint request. | engine-boundary |
| `src/lib/engine/index.ts:78` | `getStats` | class method | Runs standard checkpoint search and summarizes into `EnchantStats`. | engine-boundary, projection |
| `src/lib/engine/index.ts:107` | `prepareSearchRequest` | private method | Validates shared search request fields and attaches registry/clue context. | engine-boundary |
| `src/lib/engine/index.ts:117` | `getPackedClue` | private method | Validates and packs clue input. | engine-boundary, clue |
| `src/lib/engine/index.ts:121` | `validateRequest` | private method | Validates request item/material/clue fields. | engine-boundary |

### Engine Cache

File: `src/lib/engine/cache/CacheManager.ts`

| Location | Symbol | Kind | Responsibility | Tags |
|---|---|---|---|---|
| `src/lib/engine/cache/CacheManager.ts:21` | `CacheManager.constructor` | constructor | Initializes pool LRU cache. | cache |
| `src/lib/engine/cache/CacheManager.ts:26` | `getDist` | class method | Reads modified-level distribution cache. | cache |
| `src/lib/engine/cache/CacheManager.ts:31` | `setDist` | class method | Writes modified-level distribution cache. | cache |
| `src/lib/engine/cache/CacheManager.ts:36` | `getPool` | class method | Reads eligible-pool cache. | cache |
| `src/lib/engine/cache/CacheManager.ts:41` | `setPool` | class method | Writes eligible-pool cache. | cache |
| `src/lib/engine/cache/CacheManager.ts:47` | `clearAll` | class method | Clears all engine caches and metrics. | cache |
| `src/lib/engine/cache/CacheManager.ts:53` | `resetMetrics` | class method | Resets all engine cache metrics. | cache, instrumentation |
| `src/lib/engine/cache/CacheManager.ts:58` | `getMetrics` | class method | Returns raw internal cache metrics. | cache, instrumentation |
| `src/lib/engine/cache/CacheManager.ts:68` | `getEngineMetrics` | class method | Returns metrics in public instrumentation field shape. | cache, instrumentation |

### Test Helpers

| Location | Symbol | Kind | Responsibility | Tags |
|---|---|---|---|---|
| `tests/unit/search/search-run.test.ts:9` | `totalMassUnits` | test helper | Sums mass-accounting buckets for conservation assertions. | test-only |
| `tests/unit/search/search-run.test.ts:20` | `resultMassUnits` | test helper | Sums resolved result mass. | test-only |
| `tests/unit/search/search-run.test.ts:26` | `SingleModifiedLevelDistribution` | test helper class | Forces one modified level for residue/unit tests. | test-only |
| `tests/unit/search/search-execution-service.test.ts:8` | `accountingTotal` | test helper | Sums accounting units for search-result assertions. | test-only |

## Recommended Rename Order

1. **Registry kernel pass**
   - Done: renamed `SearchRegistryContext` -> `RegistryKernel`.
   - Done: renamed file/test/imports/exports/error strings.
   - Done: renamed local variables from `context` to `kernel` where they refer to the kernel object.
   - Still required before commit: run `npm run lint` and `npx tsx --test tests/unit/search/*.test.ts tests/diagnostics/instrumentation.test.ts`.

2. **Doc sync pass**
   - Update `docs/v7-shared-search-engine.md` with `RegistryKernel` vocabulary.
   - Update this doc's current-file paths if the rename lands.

3. **Protocol vocabulary pass, optional**
   - Consider `projectTopRun` -> `reprojectTopRun`.
   - Keep this separate because worker protocol names and UI callbacks are involved.

4. **UI options vocabulary pass, optional**
   - Consider `UiMetadataService` -> `UiOptionsService` or `InputOptionsService`.
   - Keep separate because this is UI/domain query vocabulary, not shared-search internals.

5. **Checkpoint target naming pass, optional**
   - Consider `targetClassifiedMass` -> `minClassifiedMass` / `classifiedMassGoal`.
   - Keep separate because it touches protocol/config/request validation.

## Open Questions

- Should `SearchPool*` types remain search-prefixed, or should they become `Pool*` once scoped under `RegistryKernel.ts`?
- Should `groupLevelsByPoolSignature` remain public if only tests/debugging use it?
- Should `SearchGraph.getBookMode` move into the kernel to keep graph less registry-aware?
- Is `refinement` acceptable as product vocabulary, or should checkpoint policy use `checkpointLevel` internally?
- Is `top` acceptable as the selected-XP lane name, or should it be split from top-N ranking vocabulary?
- Should `projectTopRun` be renamed before the worker protocol becomes harder to change?

## References / Related Docs

- `docs/v7-shared-search-engine.md`
- `src/lib/search/registry/RegistryKernel.ts`
- `src/lib/search/SearchGraph.ts`
- `src/lib/search/SearchRun.ts`
- `src/lib/search/SearchExecutionService.ts`
- `src/ui/refinement.ts`
- `src/ui/worker-client.ts`
- `src/worker/top-worker.ts`
- `src/worker/chart-worker.ts`

## Owner / Maintainer

Jonathan Braver / Thing 2

## Last Updated

2026-05-11
