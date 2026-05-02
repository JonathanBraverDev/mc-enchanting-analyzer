# Architecture Map - Minecraft Enchantment Analyzer (V5)

## Entry Points

| Entry point | Purpose |
|---|---|
| `src/lib/index.ts` | Public library API: engine, registry, data, types, and utilities |
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
  utils/           Probability math, key packing, async helpers, heaps
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

## V5 Search Flow

V5 centers the engine around checkpoint-capable searches. A normal calculation searches to one target checkpoint and summarizes the final result. UI refinement can instead search a sequence of checkpoints and stream a completed result each time a checkpoint is crossed.

```text
UI input
  -> WorkerClient.startTopRun / startChartRun
  -> top-worker or chart-worker
  -> WorkerShell.dispatchEvent
  -> EnchantEngine.searchSequentialCheckpoints or searchToCheckpoint
  -> SearchService.searchModifiedLevel for each modified level
  -> SearchController best-first expansion
  -> SearchStateTracker and ProbabilityMassAccountant
  -> SearchResult at each checkpoint
  -> SnapshotService / SummaryService
  -> worker response back to UI
```

## Public Engine Calls

| API | Purpose |
|---|---|
| `calculate({ cat, xp, mat, ...config })` | Runs a standard calculation and returns summarized `CalculationStats` |
| `searchToCheckpoint({ cat, xp, mat, ...config })` | Searches one target checkpoint and returns a `SearchResult` |
| `searchSequentialCheckpoints({ cat, xp, mat, checkpoints, onCheckpointComplete, ...config })` | Searches multiple checkpoints in order and streams each completed `SearchResult` |
| `searchModifiedLevel({ cat, modLevel, mat, ...config })` | Searches one modified level and returns its reusable `SearchState` |
| `getModifiedLevelDist(xp, enchantability, instrumentation?)` | Returns the BigInt distribution over modified levels |
| `getEligibleListNumeric(cat, level, bitset?)` | Returns packed eligible enchant/rank IDs for a category and level |

The public calls use request objects so callers can pass optional search, instrumentation, timing, clue, and abort options without positional argument drift.

## Search Components

| Component | Role |
|---|---|
| `EnchantEngine` | Validates requests, owns registry access, cache lookups, and public orchestration |
| `SearchService` | Coordinates modified-level search, checkpoint aggregation, instrumentation, and cache reuse |
| `SearchController` | Runs the best-first expansion loop until threshold, iteration, abort, or exhaustion |
| `SearchProcessor` | Performs low-level node expansion and probability forwarding |
| `SearchStateTracker` | Tracks search state and mass accounting for one modified level |
| `ProbabilityMassAccountant` | Records resolved, pending, sieved, capped, overflow, and rounding mass |
| `ModifiedLevelDistributionService` | Computes the BigInt distribution of modified enchantment levels |
| `SummaryService` | Converts `SearchResult` maps and accounting into presented `CalculationStats` |
| `SnapshotService` | Builds UI/reporting snapshots from `SearchResult` plus frontier state |

## Checkpoint Aggregation

`SearchResult` is the engine-native checkpoint output:

```ts
interface SearchResult {
  combos: Map<PackedCombo, bigint>;
  tracker: SearchStateTracker;
  frontiers?: { heap: SearchHeap; scale: bigint }[];
  instrumentation?: EngineInstrumentation;
  timing?: SearchTiming;
  threshold: number;
}
```

For each modified level, `SearchService` searches or resumes a `SearchState`, scales it by the modified-level probability, and records it into one checkpoint accumulator. The accumulator owns:

- global combo mass
- aggregated mass tracker
- frontier references for snapshot reporting
- processed modified-level probability
- timing and instrumentation snapshots

If a sequential checkpoint run is aborted before any modified level is processed for the active checkpoint, the service returns the last completed checkpoint instead of replacing it with an empty result.

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
| pool cache | Eligible enchant pools by version/category/level/material |
| frontier cache | Reusable modified-level search states |
| stats cache | Final `CalculationStats` summaries |

Search-state cache keys include version, category, material, modified level, and clue where relevant. Threshold-aware reads can reuse more precise cached state when it already satisfies the requested checkpoint.

## Release Documentation Rule

Major releases are expected to update this architecture map and at least one other top-level project document. Minor releases should update docs when behavior or workflows change. Patch releases are exempt unless the patch itself changes user-facing behavior or project process.
