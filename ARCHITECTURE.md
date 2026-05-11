# Architecture Map - Minecraft Enchantment Analyzer (V6)

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

The bundled enchantment registry models the active enchanting-table space. Treasure-only or otherwise table-impossible enchantments are intentionally excluded from `global_enchantments` instead of being carried through the registry behind per-item filters. V6 constructs runtime engines from resolved `RegistryState` objects; normal vanilla callers build those states by version, while vanilla-plus-mutation registries are an explicit advanced path.

## Checkpoint Search Flow

V5 centers the engine around checkpoint-capable searches. A normal calculation searches to one target checkpoint and summarizes the final result. UI refinement can instead search a sequence of checkpoints and stream a completed result each time a checkpoint is crossed.

```text
UI input
  -> WorkerClient.startTopRun / startChartRun
  -> top-worker or chart-worker
  -> WorkerShell.dispatchEvent
  -> EnchantEngine.searchSequentialCheckpoints or searchToCheckpoint
  -> SearchService.searchModifiedLevel for each modified level
  -> SearchController best-first expansion
  -> NodeIdSearchFrontier + SearchNodeGraph + MassForwardingEngine
  -> SearchStateTracker and ProbabilityMassAccountant
  -> SearchResult at each checkpoint
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

The public calls use request objects so callers can pass optional search, instrumentation, timing, clue, and abort options without positional argument drift. Use `getStats(...)` when a caller wants usable presented probabilities; use checkpoint calls when a caller needs raw search state or streaming checkpoint control. `getStats(...)` fills missing threshold/iteration settings from the default stats checkpoint (`DEFAULT_STATS_REFINEMENT_LEVEL`, currently `standard`) so simple callers and tests share one reliable baseline. V6 uses `item` and `material` consistently across engine calls, workers, UI code, tests, and scripts.

## Registry Construction

| API | Purpose |
|---|---|
| `RegistryFactory.build(version)` | Builds the bundled vanilla registry for a Minecraft version |
| `RegistryFactory.buildWithMutations(version, mutations)` | Builds a vanilla registry with targeted rule or enchantment mutations applied |
| `EngineFactory.createForVersion(version, overrides?)` | Builds or reuses a cached vanilla engine for a version |
| `EngineFactory.create(registry, overrides?)` | Creates an engine around an already resolved vanilla or mutated registry |

Runtime registry state contains projected lookup data such as active item pools, item/material compatibility, enchantability tables, conflict bitsets, material values, and rank maps. Raw registry data remains in the data/factory layer rather than being carried on each engine registry object.

V6 intentionally keeps custom registry support narrow: the supported extension point is vanilla plus explicit mutations. Full custom data-pack construction is not part of the public runtime surface.

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
| `SearchService` | Coordinates modified-level search, checkpoint aggregation, instrumentation, and cache reuse |
| `SearchController` | Runs the best-first expansion loop until threshold, iteration, abort, or exhaustion |
| `NodeIdSearchFrontier` | Stores pending node IDs and probability mass in best-first order |
| `SearchNodeGraph` | Owns canonical node identity, optional split-mask node state, combo payloads, expansion blueprints, and forwarding residue |
| `MassForwardingEngine` | Forwards mass through cached graph nodes and routes unresolved child mass back to the frontier |
| `SearchProcessor` | Builds Minecraft-specific expansion blueprints, performs eligibility/conflict checks, and settles generated mass |
| `SearchPoolPlan` | Precomputes fixed per-level pool metadata, identity mode, weights, masks, conflicts, and initial child payloads |
| `SearchStateTracker` | Holds bucketed mass accounting for one modified level |
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
  combos: Map<PackedCombo, bigint>;
  tracker: SearchStateTracker;
  frontiers?: { frontier: NodeIdSearchFrontier; graph: SearchNodeGraph; scale: bigint }[];
  instrumentation?: EngineInstrumentation;
  timing?: SearchTiming;
  threshold: number;
}
```

For each modified level, `SearchService` searches or resumes a `SearchState`, scales it by the modified-level probability, and records it into one checkpoint accumulator. `SearchState` stores the current node-ID frontier, the graph that resolves those IDs back to canonical combo nodes, exact combo results, and the mass tracker. The accumulator owns:

- global combo mass
- aggregated mass tracker
- frontier references for snapshot reporting
- processed modified-level probability
- timing and instrumentation snapshots

If a sequential checkpoint run is aborted before any modified level is processed for the active checkpoint, the service returns the last completed checkpoint instead of replacing it with an empty result.

When a request includes a displayed clue, `EnchantEngine` validates the clue label and forwards the packed clue target into the search path. `ClueSearchPolicy` lets the search skip branches that select conflicting enchantments, select the same enchantment at the wrong rank, or settle without the displayed clue. That pruned mass is recorded as `clueIncompatible`; the Bayesian clue denominator is still derived later during reporting as `clue.knownSpace`.

## Reporting Aggregation

`SummaryAggregationService` is the shared scanner for post-search reporting. It walks resolved combo maps and pending frontier nodes once, scales pending frontier mass once per node, and derives `any`, `ranks`, `count`, and `shownClueDistribution` together. Pending book nodes preserve the existing book-adjusted `any`/`ranks`/`count` behavior while shown-clue mass remains based on the packed frontier combo. `SummaryService` and `SnapshotService` then format those aggregate masses for public stats and UI snapshots. For clue-conditioned output, `clue.knownSpace` is derived from displayed clue mass; it is not stored in engine mass accounting. Because clue-pruned searches no longer retain a full distribution for every possible displayed clue, conditioned output omits `shownClueDistribution`.

Target combo filtering is a reporting projection, not a search mode. The UI sends minimum-rank requirements such as `Efficiency IV+` and `Fortune III+`; `TargetAnalysisService` validates that the requirements can coexist, scans the checkpoint result before display limits are applied, and returns matching mass, top matching combos, and near-miss diagnostics. For unconditioned top results with active targets, `TargetClueAdvisorService` ranks possible shown table clues by `P(targets | shown clue)` and reports both the conditioned target chance and how often each clue appears. Top-result target changes can reuse cached checkpoint `SearchResult` objects in the top worker, so changing targets does not rerun the engine when the base item, level, clue, and refinement inputs are unchanged.

## Node-ID Frontier Model

The V5 search path separates node identity from frontier priority:

- `SearchNodeGraph` assigns each canonical `(enchant bitset << 8 | current level)` state a dense `nodeId`.
- `SearchPoolPlan` selects the internal identity mode from the registry max enchant ID: `number53` for IDs `0..44`, `bigint64` for IDs `45..63`, and a clear unsupported-registry error above that range.
- In `number53` mode, graph identity is stored as a safe packed number key plus split masks: `maskLo`, `maskHi`, and `level`.
- In `bigint64` mode, graph identity stays on canonical BigInt meta keys while preserving the same node-ID frontier and result shape.
- `SearchPoolPlan` precomputes matching low/high ID masks and conflict masks for each eligible enchant, so `number53` expansion can use numeric selected/conflict checks instead of rebuilding BigInt state.
- The graph stores the node payload once: split masks, level, packed combo, enchant count, optional `ExpansionBlueprint`, and forwarding residue.
- `NodeIdSearchFrontier` stores only `nodeId` and pending probability mass, using direct typed-array indexes for merge and heap-position lookups.
- Expansion blueprints point to child node IDs, so cached-child checks are array lookups instead of BigInt heap/hash work.
- `getMeta(nodeId)` remains available for compatibility and reporting; numeric nodes reconstruct the BigInt meta lazily only when a caller asks for it.

This preserves the old best-first semantics: the highest-probability pending node still expands first, and `meta` remains the canonical state identity. The scaling improvement comes from removing repeated `BigInt meta + packed combo` traffic from frontier push/pop/merge operations.

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
| frontier cache | Reusable modified-level search states keyed by version/item/material/modified level |

The registry rule model declares item/material compatibility together, but the engine cache keys still follow the computation they cache. Pool entries only depend on the fixed enchantable item pool at a modified level. Frontier entries include material because material changes enchantability, which changes the modified-level distribution and therefore the weighted search state. Threshold-aware reads can reuse more precise cached state when it already satisfies the requested checkpoint.

## Release Documentation Rule

Major releases are expected to update this architecture map. Minor releases should update docs when behavior or workflows change. Patch releases are exempt unless the patch itself changes user-facing behavior or project process.
