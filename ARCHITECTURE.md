# Architecture Map - Minecraft Enchantment Analyzer (V7)

## Common Description

This document maps the current V7 engine, worker, registry, search, and reporting architecture for Minecraft Enchantment Analyzer. It is the high-level reference for how the system is wired; use `docs/v7-shared-search-engine.md` for the deeper explanation of why V7 works this way.

Release-reviewed for v7.1.2: the public engine surface is `getStats(...)` for summarized probabilities plus checkpoint APIs for raw or streaming search results.

## Table of Contents

- [Entry Points](#entry-points)
- [Module Dependency Graph](#module-dependency-graph)
- [Checkpoint Search Flow](#checkpoint-search-flow)
- [Public Engine Calls](#public-engine-calls)
- [Registry Construction](#registry-construction)
- [Registry Rule Model](#registry-rule-model)
- [Search Components](#search-components)
- [Checkpoint Aggregation](#checkpoint-aggregation)
- [Reporting Aggregation](#reporting-aggregation)
- [Shared Frontier Model](#shared-frontier-model)
- [Worker Model](#worker-model)
- [Caching Strategy](#caching-strategy)
- [Release Documentation Rule](#release-documentation-rule)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Entry Points

| Entry point | Purpose |
|---|---|
| `src/lib/index.ts` | Public library API: engine, registry factories, data, types, and utilities |
| `src/ui/index.ts` | Browser UI entry: wires DOM controls, workers, refinement, and charts |
| `src/worker/top-worker.ts` | Worker for the selected XP/top-results view |
| `src/worker/chart-worker.ts` | Worker for XP sweep chart cells |
| `src/worker/WorkerShell.ts` | Shared worker lifecycle, initialization, run cancellation, and error routing |

## Module Dependency Graph

```text
src/lib/
  constants/       Minecraft rules, engine limits, UI defaults
  data/            JSON-shaped version data
  types/           Domain, engine, mass, and worker protocol types
  utils/           Probability math, key packing, and async helpers
  core/            Registry construction, lookup helpers, clue validation
  engine/          EnchantEngine, search services, state tracking, accounting
  services/        Snapshot, summary, humanization, and refinement services
  index.ts         Public library API

src/ui/            Browser UI layer
src/worker/        Dedicated worker entry points and protocol shell
tests/             Unit, integration, diagnostics, and UI checks
scripts/           Build, profiling, reporting, and snapshot tools
```

Dependency direction is intentionally one way: data and types sit at the bottom, engine code owns search behavior, services translate engine output into UI/reporting shapes, workers isolate long-running calculations, and the UI consumes worker responses.

The bundled enchantment registry models the active enchanting-table space. Treasure-only or otherwise table-impossible enchantments are intentionally excluded from `global_enchantments` instead of being carried through the registry behind per-item filters. V7 constructs runtime engines from resolved `RegistryState` objects; normal vanilla callers build those states by version, while vanilla-plus-mutation registries are an explicit advanced path.

## Checkpoint Search Flow

V7 centers the engine around checkpoint-capable shared searches. A normal stats call searches to the default stats checkpoint and summarizes the final result. UI refinement can instead search a sequence of checkpoints and stream a completed result each time a checkpoint is crossed. Search scheduling is global: modified-level mass is seeded into one weighted frontier, so the highest-probability pending state is expanded next regardless of which modified level produced it.

```text
UI input
  -> WorkerClient.startTopRun / startChartRun
  -> top-worker or chart-worker
  -> WorkerShell.dispatchEvent
  -> EnchantEngine.searchSequentialCheckpoints or searchToCheckpoint
  -> SearchExecutionService
  -> SearchRun seeded with weighted modified-level root mass
  -> SearchRunFrontier + SearchGraph best-first expansion
  -> ProbabilityMassAccountant
  -> SearchRunSnapshot / SearchResult at each checkpoint
  -> SummaryAggregationService
  -> SnapshotService / SummaryService
  -> worker response back to UI
```

## Public Engine Calls

| API | Purpose |
|---|---|
| `getStats({ item, xp, material, ...config })` | Runs the standard checkpoint search and returns summarized `EnchantStats` for product/tool callers |
| `searchToCheckpoint({ item, xp, material, ...config })` | Searches one target checkpoint and returns a raw `SearchResult` |
| `searchSequentialCheckpoints({ item, xp, material, checkpoints, onCheckpointComplete, ...config })` | Searches multiple checkpoints in order and streams each completed `SearchResult` |
| `searchModifiedLevel({ item, modLevel, material, ...config })` | Searches one modified level and returns its reusable `SearchState` |
| `getModifiedLevelDist(xp, enchantability, instrumentation?)` | Returns the BigInt distribution over modified levels |
| `getAvailablePool(item, level, bitset?)` | Returns packed eligible enchant/rank IDs for an item and level |

The public calls use request objects so callers can pass optional search, instrumentation, timing, clue, and abort options without positional argument drift. Use `getStats(...)` when a caller wants usable presented probabilities; use checkpoint calls when a caller needs raw search state or streaming checkpoint control. `getStats(...)` fills missing threshold/iteration settings from the default stats checkpoint (`DEFAULT_STATS_REFINEMENT_LEVEL`, currently `standard`) so simple callers and tests share one reliable baseline. V7 uses `item` and `material` consistently across engine calls, workers, UI code, tests, and scripts.

## Registry Construction

| API | Purpose |
|---|---|
| `RegistryFactory.build(version)` | Builds the bundled vanilla registry for a Minecraft version |
| `RegistryFactory.buildWithMutations(version, mutations)` | Builds a vanilla registry with targeted rule or enchantment mutations applied |
| `EngineFactory.createForVersion(version, overrides?)` | Builds or reuses a cached vanilla engine for a version |
| `EngineFactory.create(registry, overrides?)` | Creates an engine around an already resolved vanilla or mutated registry |

Runtime registry state contains projected lookup data such as active item pools, item/material compatibility, enchantability tables, conflict bitsets, material values, and rank maps. Raw registry data remains in the data/factory layer rather than being carried on each engine registry object.

V7 intentionally keeps custom registry support narrow: the supported extension point is vanilla plus explicit mutations. Full custom data-pack construction is not part of the public runtime surface.

## Registry Rule Model

Registry data is assembled from version-ranged rule tables:

- `enchantment_group_rules` define additive enchantment group membership over time, such as `sword_pool`, `armor_pool`, and item-specific extras.
- `enchantable_item_rules` define each enchantable item, its active version range, the groups or direct enchantments it can roll, the material keys or aliases it accepts, and which enchantability table it uses.
- `material_rules` define when concrete material keys exist.
- `conflict_rules` define version-ranged enchantment conflicts and are compiled into symmetric conflict bitsets.

Rule tables use inclusive `valid_from` and exclusive `valid_until`.

Missing `groups` on an enchantable item rule means “all active table enchantments” and is reserved for books. Material aliases such as `tool` and `armor` expand to concrete material keys before version filtering, so item/material compatibility is declared once instead of split across parallel pool and binding tables.

## Search Components

| Component | Role |
|---|---|
| `EnchantEngine` | Validates requests, owns registry access, cache lookups, and public orchestration |
| `SearchExecutionService` | Coordinates shared search runs, checkpoint aggregation, instrumentation, and cache reuse |
| `SearchRun` | Runs the globally weighted best-first expansion loop, mass accounting, residue forwarding, and optional suffix merging until checkpoint or exhaustion |
| `SearchRunFrontier` | Stores pending graph node IDs and weighted probability mass in best-first order |
| `SearchGraph` | Owns canonical node identity, combo payloads, exact graph expansions, suffix identities, and graph-local expansion state |
| `GroupedFlexSearchRun` / `FlexCoordinator` / `GroupedFlexGraph` | Active opt-in factorized runtime path selected with `searchBackend: 'flex'`. It uses fixed/choice result programs, V7-style mass flow, and concrete-compatible projection. See `docs/flex-factorized-tree.md`. |
| `PlexRun` / `PlexGraph` | Historical opt-in prototype that proved conflict-choice compression and projection boundaries. Retained for comparison with `searchBackend: 'plex'`. |
| `ProbabilityMassAccountant` | Records resolved, clue-incompatible, pending, sieved, capped, overflow, and rounding mass |
| `ModifiedLevelDistributionService` | Computes the BigInt distribution of modified enchantment levels |
| `SummaryAggregationService` | Scans resolved combos and pending frontiers once to derive shared any/rank/count/clue mass buckets |
| `TargetAnalysisService` | Projects target-combo filters over resolved combos and pending frontiers without changing search behavior |
| `SummaryService` | Formats aggregated checkpoint masses into presented `EnchantStats` |
| `SnapshotService` | Formats aggregated checkpoint masses into UI/reporting snapshots |

## Checkpoint Aggregation

`SearchResult` is the engine-native checkpoint output:

```ts
interface SearchResult {
  snapshot: SearchRunSnapshot;
  combos: ReadonlyMap<PackedCombo, bigint>;
  instrumentation?: EngineInstrumentation;
  timing?: SearchTiming;
  threshold: number;
}
```

`SearchExecutionService` searches or resumes the selected internal backend for the request signature. Concrete `SearchRun` remains the default and supported product path. Experimental callers can set `searchBackend: 'flex'` to run the same checkpoint service through a cached Flex run, which projects fixed/choice result programs back into the compatible checkpoint shape. Legacy comparison callers can still set `searchBackend: 'plex'`. The next V7 direction is to make the Flex projection/factorized-tree boundary internal to the default engine: graph construction can emit fixed or choice factors, while the runtime remains a mostly generic best-first mass-flow loop and the checkpoint result stays concrete-compatible. The selected run seeds each modified level as weighted root mass, expands the highest-probability pending graph node globally, and snapshots the completed checkpoint state. The checkpoint result owns:

- global combo mass
- mass accounting buckets
- a `SearchRunSnapshot` with pending entries for reporting and projections
- timing and instrumentation snapshots

If a sequential checkpoint run is aborted before any modified level is processed for the active checkpoint, the service returns the last completed checkpoint instead of replacing it with an empty result.

When a request includes a displayed clue, `EnchantEngine` validates the clue label and forwards the packed clue target into the search path. `ClueSearchPolicy` lets the search skip branches that select conflicting enchantments, select the same enchantment at the wrong rank, or settle without the displayed clue. That pruned mass is recorded as `clueIncompatible`; the Bayesian clue denominator is still derived later during reporting as `clue.knownSpace`.

## Reporting Aggregation

`SummaryAggregationService` is the shared scanner for post-search reporting. It walks resolved combo maps and pending frontier nodes once, scales pending frontier mass once per node, and derives `any`, `ranks`, `count`, and `shownClueDistribution` together. Pending book nodes preserve the existing book-adjusted `any`/`ranks`/`count` behavior while shown-clue mass remains based on the packed frontier combo. `SummaryService` and `SnapshotService` then format those aggregate masses for public stats and UI snapshots. For clue-conditioned output, `clue.knownSpace` is derived from displayed clue mass; it is not stored in engine mass accounting. Because clue-pruned searches no longer retain a full distribution for every possible displayed clue, conditioned output omits `shownClueDistribution`.

Target combo filtering is a reporting projection, not a search mode. The UI sends minimum-rank requirements such as `Efficiency IV+` and `Fortune III+`; `TargetAnalysisService` validates that the requirements can coexist, scans the checkpoint result before display limits are applied, and returns matching mass, top matching combos, and near-miss diagnostics. For unconditioned top results with active targets, `TargetClueAdvisorService` ranks possible shown table clues by `P(targets | shown clue)` and reports both the conditioned target chance and how often each clue appears. Top-result target changes can reuse cached checkpoint `SearchResult` objects in the top worker, so changing targets does not rerun the engine when the base item, level, clue, and refinement inputs are unchanged.

## Shared Frontier Model

The V7 search path separates graph node identity from weighted frontier priority:

- `SearchGraph` assigns each canonical `(enchant bitset << 8 | current level)` state a dense `nodeId`.
- `RegistryKernel` groups modified levels by `SearchPoolSignature`, so levels with the same eligible enchant pool reuse the same structural graph.
- `SearchGraph` stores canonical selected-enchant masks, current levels, packed combos, and enchant counts on dense node IDs.
- `SearchPoolEntry` precomputes rank, weight, availability, combo index, id bit, and conflict metadata for each eligible enchant.
- `SearchExpansionBlueprintCache` can reuse eligible-entry scans across rank-variant pools through `SearchPoolFamilySignature`; exact child nodes and combo payloads remain graph-local.
- `SearchRunFrontier` stores `graphId`, `nodeId`, and pending weighted probability mass, using direct merge/heap lookups for best-first scheduling.
- Forwarding residue is tracked by exact source expansion and outgoing edge, so fixed-point leftovers can recover only when later mass reaches the same equivalence point.
- Suffix identity and suffix merging are implemented but opt-in; default product searches do not canonicalize pending suffix nodes because current profiling shows the overhead can outweigh the iteration savings.
- Flex search is implemented as an opt-in internal backend selected through `SearchExecutionService` with `searchBackend: 'flex'`. It keeps structural mass flow separate from visible fixed/choice result programs, can project resolved and pending aggregate state back into concrete compatibility rows, and is still not selected for product/default requests. Plex remains a legacy comparison backend. The current design target is to reuse Flex inside V7 itself: factorized tree nodes carry emitted result-program IDs, while traversal can stay dense/generic even after an earlier choice factor was emitted.

This preserves best-first semantics while changing the scheduling scope: the highest-probability pending weighted node expands first across the whole XP search, not inside one modified level at a time. `meta` remains the canonical state identity. The scaling improvement comes from sharing graph identity and cache state across the weighted run instead of repeating independent per-modified-level searches.

## Worker Model

The browser uses two dedicated workers:

| Worker | Purpose |
|---|---|
| `top-worker.ts` | Searches selected XP input through refinement checkpoints and streams top-result snapshots |
| `chart-worker.ts` | Sweeps XP levels for chart cells at each refinement level |

`WorkerShell` centralizes engine initialization, active run tracking, abort/supersede behavior, terminal messages, and error responses. Worker messages enter through `dispatchEvent`, which rejects mismatched origins when an origin is present.

## Caching Strategy

`CacheManager` owns version-scoped caches:

| Cache | Purpose |
|---|---|
| distribution cache | Modified-level distributions by version/xp/enchantability |
| pool cache | Eligible enchant pools by version/item/level; material is intentionally absent because it affects modified-level distribution, not per-level eligibility |
| search run cache | Reusable shared search runs keyed by version/item/material/xp/clue/request signature |
| expansion blueprint cache | Reusable eligible-entry scans keyed by pool-family signature, selected mask, current level, and enchant count |

The registry rule model declares item/material compatibility together, but the engine cache keys still follow the computation they cache. Pool entries only depend on the fixed enchantable item pool at a modified level. Search run entries include material because material changes enchantability, which changes the modified-level distribution and therefore the weighted search state. Threshold-aware reads can reuse more precise cached state when it already satisfies the requested checkpoint.

Expansion blueprint caching is enabled by default because it preserves exact graph edges while reducing repeated candidate checks. Suffix merging is implemented behind `useSuffixMerging` but remains off by default because lower iteration counts have not consistently translated into faster wall-clock runtime. Flex search is available as an opt-in `SearchExecutionService` backend for internal experiments, comparison tests, and refinement work, but remains outside the default execution path until broader parity, mutated-registry safety, and wall-clock evidence justify enabling it. The vNext performance thesis is not a separate public Flex engine; it is V7 running a better factorized tree where program construction happens during graph building and checkpoint projection hides the internal representation from UI/reporting callers. Plex remains available for historical comparison.

## Release Documentation Rule

Major releases are expected to update this architecture map. Minor releases should update docs when behavior or workflows change. Patch releases are exempt unless the patch itself changes user-facing behavior or project process.

## References / Related Docs

- `README.md` — product overview and setup.
- `MASS_HANDLING.md` — V7 probability accounting and residue rules.
- `docs/v7-shared-search-engine.md` — deep V7 current-state design reference.
- `docs/flex-factorized-tree.md` — active Flex/factorized-tree design notes.
- `docs/plex-factorized-tree.md` — historical Plex prototype notes.

## Owner / Maintainer

Jonathan Braver / V7 engine maintainers.

## Last Updated

2026-05-21
