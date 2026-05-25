# Architecture Map - Minecraft Enchantment Analyzer

## Common Description

This document maps the current engine, worker, registry, search, and reporting architecture for Minecraft Enchantment Analyzer. Use `docs/v8-search-engine.md` for the deeper explanation of how the current search engine works.

Release-reviewed for v7.1.2: the public engine surface is `getStats(...)` for summarized probabilities plus checkpoint APIs for raw or streaming search results. For the current supported API boundary, see [`docs/public-api.md`](docs/public-api.md).

## Table of Contents

- [Entry Points](#entry-points)
- [Supported API Boundary](#supported-api-boundary)
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

## Supported API Boundary

The supported library API is the engine and registry surface used by the UI and normal tool callers:

- `EngineFactory.createForVersion(...)` and `EngineFactory.create(...)`;
- `EnchantEngine.getStats(...)`;
- `EnchantEngine.searchToCheckpoint(...)`;
- `EnchantEngine.searchSequentialCheckpoints(...)`;
- registry construction and metadata helpers needed to build valid requests;
- returned `EnchantStats`, `SearchResult`, snapshot, timing, and accounting shapes.

Direct search-engine classes, backend selectors such as `searchBackend`, and implementation-specific runners are internal diagnostics. They may change as the engine evolves. The product API should not require callers to know which internal runtime is active.

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

The bundled enchantment registry models the active enchanting-table space. Treasure-only or otherwise table-impossible enchantments are intentionally excluded from `global_enchantments` instead of being carried through the registry behind per-item filters. V8 constructs runtime engines from resolved `RegistryState` objects; normal vanilla callers build those states by version, while vanilla-plus-mutation registries are an explicit advanced path.

## Checkpoint Search Flow

V8 centers the engine around checkpoint-capable shared searches. A normal stats call searches to the default stats checkpoint and summarizes the final result. UI refinement can instead search a sequence of checkpoints and stream a completed result each time a checkpoint is crossed. Search scheduling is global: modified-level mass is seeded into one weighted frontier, so the highest-probability pending state is expanded next regardless of which modified level produced it.

```text
UI input
  -> WorkerClient.startTopRun / startChartRun
  -> top-worker or chart-worker
  -> WorkerShell.dispatchEvent
  -> EnchantEngine.searchSequentialCheckpoints or searchToCheckpoint
  -> SearchExecutionService
  -> FlexCoordinator seeded with weighted modified-level root mass
  -> GroupedFlexGraph best-first expansion
  -> ProbabilityMassAccountant
  -> EngineSearchSnapshot / SearchResult at each checkpoint
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

The public calls use request objects so callers can pass optional search, instrumentation, timing, clue, and abort options without positional argument drift. Use `getStats(...)` when a caller wants usable presented probabilities; use checkpoint calls when a caller needs raw search state or streaming checkpoint control. `getStats(...)` fills missing threshold/iteration settings from the default stats checkpoint (`DEFAULT_STATS_REFINEMENT_LEVEL`, currently `standard`) so simple callers and tests share one reliable baseline. V8 uses `item` and `material` consistently across engine calls, workers, UI code, tests, and scripts.

## Registry Construction

| API | Purpose |
|---|---|
| `RegistryFactory.build(version)` | Builds the bundled vanilla registry for a Minecraft version |
| `RegistryFactory.buildWithMutations(version, mutations)` | Builds a vanilla registry with targeted rule or enchantment mutations applied |
| `EngineFactory.createForVersion(version, overrides?)` | Builds or reuses a cached vanilla engine for a version |
| `EngineFactory.create(registry, overrides?)` | Creates an engine around an already resolved vanilla or mutated registry |

Runtime registry state contains projected lookup data such as active item pools, item/material compatibility, enchantability tables, conflict bitsets, material values, and rank maps. Raw registry data remains in the data/factory layer rather than being carried on each engine registry object.

V8 intentionally keeps custom registry support narrow: the supported extension point is vanilla plus explicit mutations. Full custom data-pack construction is not part of the public runtime surface.

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
| `GroupedFlexSearchRun` / `FlexCoordinator` / `GroupedFlexGraph` | Runs the globally weighted best-first expansion loop, grouped graph expansion, fixed/choice result programs, mass accounting, residue forwarding, and checkpoint exits. See `docs/v8-search-engine.md`. |
| `FlexProgramStore` | Stores fixed and choice emissions for exact result projection without expanding every concrete combo in the search loop |
| `FlexSnapshotBuilder` / `FlexProjector` | Builds checkpoint snapshots, exact result combos, pending aggregates, and book/clue projection views |
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
  snapshot: EngineSearchSnapshot;
  combos: ReadonlyMap<PackedCombo, bigint>;
  instrumentation?: EngineInstrumentation;
  timing?: SearchTiming;
  threshold: number;
}
```

`SearchExecutionService` searches or resumes the current V8 run for the request signature. Unsupported backend selector values fail through the shared unsupported-backend path. The engine keeps the factorized-tree boundary internal: graph construction can emit fixed or choice factors, while the runtime remains a mostly generic best-first mass-flow loop and the checkpoint result stays public-compatible. The selected run seeds each modified level as weighted root mass, expands the highest-probability pending graph node globally, and snapshots the completed checkpoint state. The checkpoint result owns:

- global combo mass
- mass accounting buckets
- an `EngineSearchSnapshot` with pending frontier data for reporting and projections
- timing and instrumentation snapshots

If a sequential checkpoint run is aborted before any modified level is processed for the active checkpoint, the service returns the last completed checkpoint instead of replacing it with an empty result.

When a request includes a displayed clue, `EnchantEngine` validates the clue label and forwards the packed clue target into the search path. `ClueSearchPolicy` lets the search skip branches that select conflicting enchantments, select the same enchantment at the wrong rank, or settle without the displayed clue. That pruned mass is recorded as `clueIncompatible`; the Bayesian clue denominator is still derived later during reporting as `clue.knownSpace`.

## Reporting Aggregation

`SummaryAggregationService` is the shared scanner for post-search reporting. It walks resolved combo maps and pending frontier nodes once, scales pending frontier mass once per node, and derives `any`, `ranks`, `count`, and `shownClueDistribution` together. Pending book nodes preserve the existing book-adjusted `any`/`ranks`/`count` behavior while shown-clue mass remains based on the packed frontier combo. `SummaryService` and `SnapshotService` then format those aggregate masses for public stats and UI snapshots. For clue-conditioned output, `clue.knownSpace` is derived from displayed clue mass; it is not stored in engine mass accounting. Because clue-pruned searches no longer retain a full distribution for every possible displayed clue, conditioned output omits `shownClueDistribution`.

Target combo filtering is a reporting projection, not a search mode. The UI sends minimum-rank requirements such as `Efficiency IV+` and `Fortune III+`; `TargetAnalysisService` validates that the requirements can coexist, scans the checkpoint result before display limits are applied, and returns matching mass, top matching combos, and near-miss diagnostics. For unconditioned top results with active targets, `TargetClueAdvisorService` ranks possible shown table clues by `P(targets | shown clue)` and reports both the conditioned target chance and how often each clue appears. Top-result target changes can reuse cached checkpoint `SearchResult` objects in the top worker, so changing targets does not rerun the engine when the base item, level, clue, and refinement inputs are unchanged.

## Shared Frontier Model

The V8 search path separates graph node identity from weighted frontier priority:

- `GroupedFlexGraph` assigns each canonical future state a dense `nodeId`.
- `RegistryKernel` groups modified levels by `SearchPoolSignature`, so levels with the same eligible enchant pool reuse the same structural graph.
- Internal nodes store exclusion masks, current levels, enchant counts, and program IDs on dense node IDs.
- `SearchPoolEntry` precomputes rank, weight, availability, combo index, id bit, and conflict metadata for each eligible enchant.
- Same-future alternatives can collapse into a `PlexNode`, while singleton transitions remain `SolidNode`s.
- The frontier stores `graphId`, `nodeId`, and pending weighted probability mass, using direct merge/heap lookups for best-first scheduling.
- Forwarding residue is tracked by exact source expansion and outgoing edge, so fixed-point leftovers can recover only when later mass reaches the same equivalence point.
- Mutated-registry safety can switch from reduced node identity to program-aware identity when reduced identity is not sufficient.

This preserves best-first semantics while changing the scheduling scope: the highest-probability pending weighted node expands first across the whole XP search, not inside one modified level at a time. The scaling improvement comes from sharing graph identity and cache state across the weighted run instead of repeating independent per-modified-level searches.

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
| search run cache | Reusable V8 runs keyed by version/item/material/xp/clue/request signature |
| grouped graph cache | Reusable grouped graphs keyed by pool signature and search policy |

The registry rule model declares item/material compatibility together, but the engine cache keys still follow the computation they cache. Pool entries only depend on the fixed enchantable item pool at a modified level. Search run entries include material because material changes enchantability, which changes the modified-level distribution and therefore the weighted search state. Threshold-aware reads can reuse more precise cached state when it already satisfies the requested checkpoint.

Grouped graph caching preserves exact search behavior while reducing repeated candidate checks. The internal implementation is behind the stable engine API, not a separate public engine. Program construction happens during graph building, while checkpoint projection hides the internal representation from UI/reporting callers. The obsolete Plex prototype was removed after the current implementation covered the same diagnostic role with better alignment and cleaner clue behavior.

## Release Documentation Rule

Major releases are expected to update this architecture map. Minor releases should update docs when behavior or workflows change. Patch releases are exempt unless the patch itself changes user-facing behavior or project process.

## References / Related Docs

- `README.md` — product overview and setup.
- `docs/README.md` — documentation map.
- `MASS_HANDLING.md` — V8 probability accounting and residue rules.
- `docs/v8-search-engine.md` — deep V8 search and factorized-tree design reference.

## Owner / Maintainer

Jonathan Braver / V8 search engine maintainers.

## Last Updated

2026-05-24
