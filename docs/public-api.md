# Public API Boundary

## Common Description

This document defines the supported library surface for application and tool callers. The search implementation can change underneath this boundary without requiring product callers to change how they create engines or request results.

The short version:

- supported callers create an `EnchantEngine` through `EngineFactory`;
- supported callers request summarized probabilities through `engine.getStats(request)`;
- registry objects returned from `RegistryFactory` are public handles, not full runtime tables;
- checkpoint snapshots, direct search classes, and engine implementation selectors are internal diagnostics, not product API.

## Supported Entry Points

Import from the package root unless working inside the repository:

```ts
import { EngineFactory, RegistryFactory } from 'mc-enchanting-analyzer';
```

The supported construction APIs are:

| API | Purpose |
|---|---|
| `EngineFactory.createForVersion(version)` | Create an engine from a bundled vanilla version. |
| `EngineFactory.create(registry)` | Create an engine from a registry handle, including mutation-derived handles. |
| `EngineFactory.clearCaches()` | Clear shared engine-level factory caches. |
| `RegistryFactory.build(version)` | Build a vanilla registry handle. |
| `RegistryFactory.buildWithMutations(version, mutations)` | Build a mutation-derived registry handle. |

The supported engine calls are:

| API | Purpose |
|---|---|
| `engine.getStats(request)` | Return summarized probabilities for product/UI use. |
| `engine.getModifiedLevelDist(...)` | Inspect modified-level probability distribution. |
| `engine.resetCaches()` | Clear engine-owned caches. |
| `engine.getCacheMetrics()` | Inspect high-level cache hit/miss counters. |
| `engine.destroy()` | Release engine-owned resources. |

The package root intentionally does not expose raw checkpoint APIs, available-pool APIs, packed enchant/rank IDs, or conflict bitset controls. The web workers still use checkpoint snapshots and packed runtime state through internal `#engine`, `#types`, and `#services` imports, but those are repository implementation details rather than package guarantees.

## Request Surface

Stable request fields are the fields used by normal programmatic callers:

| Field | Applies To | Purpose |
|---|---|---|
| `item` | stats | Item key, such as `sword`, `book`, or `pickaxe`. |
| `material` | stats | Material key, such as `diamond`, `book`, or `bow`. |
| `xp` | stats | Player XP level used by the enchanting-table roll. |
| `clue` | stats | Optional exact table clue, such as `Sharpness III`. |
| `threshold` | stats | Stop when the largest pending mass falls below this probability. |
| `maxIterations` | stats | Work-budget stop for expensive searches. |
| `targetClassifiedMass` | stats | Stop when enough mass is resolved or classified. |
| `signal` | stats | Abort signal for host UIs. |
| `onProgress` | stats | Progress callback for host UIs. |
| `summaryLimit` | stats | Limit summarized combo rows. |
| `uncappedResults` | stats | Explicitly allow very large summary result sets. |
| `timing` | diagnostics/tools | Collect search and post-processing timing. |

Lower-level runtime knobs such as `probabilityFloor`, `exhaustive`, `drainEqualMassBand`, raw checkpoints, and instrumentation objects are internal. They exist for repository diagnostics and can change with the engine.

## Supported Results

Supported result shapes are:

| Type | Purpose |
|---|---|
| `EnchantStats` | Summarized probabilities from `getStats`. |
| `EnchantStatsRequest` | Stable request shape for `getStats`. |
| `MassAccountingBreakdown` | Public probability mass buckets. |
| `MassAccountingDetails` | Optional expanded accounting detail shape. |
| `MassAccountingStageDetails` | Expanded accounting details grouped by stage. |
| `MassAccountingOperationDetails` | Expanded accounting details grouped by operation. |
| `MassAccountingDetailBucket` | Expanded accounting bucket value plus units. |
| `MassBucketName` | Public mass bucket names. |
| `MassBucketUnits` | BigInt unit-space counterpart for public mass buckets. |
| `SearchTiming` | Optional timing measurements. |
| `ProgressUpdate` | Progress callback payload for host UIs. |
| `LevelDistribution` | Modified-level distribution returned by `getModifiedLevelDist`. |

Result probabilities and accounting are part of the supported behavior. The internal tree shape, graph node IDs, checkpoint snapshots, and backend-specific diagnostics are not.

`RegistryState`, `VanillaRegistryState`, `MutatedRegistryState`, and `BuiltRegistryState` are intentionally small public handles: `version`, `source`, `mechanics`, `multiEnchantBooks`, and mutation history for mutated registries. The full resolved registry contains packed conflict bitsets, ID maps, and cache-oriented tables that remain internal.

## Supported Registry And Rule Shapes

The package root also exposes the rule and mutation shapes needed to build mutation-derived registry handles:

| Type | Purpose |
|---|---|
| `RegistryMutation` | Describes a registry patch accepted by `RegistryFactory.buildWithMutations`. |
| `Enchantment`, `EnchantmentLevels` | Public enchantment data shape used by patch mutations. |
| `ConflictRule`, `ConflictRuleSelector` | Add or remove enchantment conflict rules. |
| `EnchantmentGroupRule`, `EnchantmentGroupRuleSelector` | Add or remove enchantment-group membership rules. |
| `MaterialRule`, `MaterialRuleSelector` | Add or remove material rules. |
| `EnchantableItemRule`, `EnchantableItemRuleSelector` | Add or remove item enchantability rules. |
| `EnchantabilityTable` | Public enchantability category names. |
| `VersionMechanics` | High-level mechanics flags exposed on registry handles. |

These types describe accepted caller input and high-level registry metadata. They do not expose the resolved runtime registry tables built from those inputs.

The generated public API report is checked into [`etc/mc-enchanting-analyzer.public.api.md`](../etc/mc-enchanting-analyzer.public.api.md). It is the machine-checked source of truth for what the package root exposes.

## Internal And Diagnostic Surface

The following are repository/internal tools. They can change or disappear when the engine implementation changes:

- `probabilityFloor`, `exhaustive`, `drainEqualMassBand`, and other runtime-only search controls;
- `SearchResult`, `EngineSearchSnapshot`, frontier views, graph/node IDs, and pending-entry snapshots;
- full resolved registry internals such as conflict bitsets, packed ID maps, and weight tables;
- `EngineInstrumentation` and backend-specific diagnostic counters;
- direct imports of `SearchExecutionService`;
- direct imports from `src/lib/search/flex/**`;
- direct use of `GroupedFlexSearchRun`, `FlexCoordinator`, `FlexProjector`, or `FlexProgramStore`;
- direct runtime parity scripts and profiling scripts;
- backend labels in diagnostics, except as best-effort internal telemetry.

## Engine Replacement Policy

The project may replace the internal search runtime in a minor release when the supported API above remains stable:

- callers still create engines through `EngineFactory`;
- public `EnchantStatsRequest` fields keep their meaning;
- `EnchantStats`, accounting, and timing remain compatible;
- public probabilities and accounting stay semantically equivalent;
- internal engine names, diagnostic selectors, and direct search classes may change.

The active search implementation should remain behind the supported API, not become a new product-facing API.

## Release Policy

### v8.0.0 Review

The V8 release keeps the supported package-root API centered on `EngineFactory`,
`RegistryFactory`, `EnchantEngine`, summarized stats results, mass accounting,
and mutation-derived registry handles. The release removes legacy and prototype
search internals behind that boundary, but does not promote checkpoint snapshots,
backend selectors, full registry tables, or direct `src/lib/search/flex/**`
imports into supported caller API.

Minor and major releases must update this file in the final release metadata commit. That update can be a no-op review note when the boundary did not change, but the file should still be touched so reviewers explicitly confirm whether the supported API changed, stayed stable, or reclassified previously experimental surface.

Major releases must also have a human-readable changelog name, using the established `### The "..." Update` style.

## References

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) for high-level engine and worker flow.
- [`MASS_HANDLING.md`](../MASS_HANDLING.md) for probability conservation and accounting.
- [`docs/search-engine.md`](search-engine.md) for search behavior, factorized-tree design, and invariants.
