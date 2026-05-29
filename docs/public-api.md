# Public API Boundary

## Common Description

This document defines the supported library surface for application and tool callers. The V8 search implementation can change underneath this boundary without requiring product callers to change how they create engines or request results.

The short version:

- supported callers create an `EnchantingAnalyzer`;
- supported callers request human-readable probabilities through `analyzer.analyze(request)`;
- supported callers request compact probabilities through `analyzer.analyzeRaw(request)`;
- supported callers convert raw results through `analyzer.humanize(result)`;
- registry construction, result translation, and engine creation are owned by the analyzer facade;
- checkpoint snapshots, direct search classes, full registry tables, and engine implementation details are internal diagnostics, not product API.

## Supported Entry Points

Import from the package root unless working inside the repository:

```ts
import { EnchantingAnalyzer } from 'mc-enchanting-analyzer';
```

The supported construction APIs are:

| API | Purpose |
|---|---|
| `EnchantingAnalyzer.forVersion(version)` | Create an analyzer from a bundled vanilla version. |
| `EnchantingAnalyzer.forVersion(version, { mutations })` | Create an analyzer from a vanilla version plus targeted mutations. |
| `EnchantingAnalyzer.withMutations(version, mutations)` | Equivalent explicit mutation constructor. |

The supported analyzer calls are:

| API | Purpose |
|---|---|
| `analyzer.analyze(request, sortMode?)` | Return probabilities with enchantment names and combo labels. |
| `analyzer.analyzeRaw(request)` | Return compact machine-readable probabilities. |
| `analyzer.humanize(result, sortMode?)` | Convert an already-computed raw result into human-readable names. |
| `analyzer.registry` | Inspect high-level registry metadata without runtime lookup tables. |
| `analyzer.resetCaches()` | Clear this analyzer's backing engine caches. |
| `analyzer.getCacheMetrics()` | Inspect backing engine cache hit/miss counters. |

The package root intentionally does not expose raw checkpoint APIs. The web workers still use checkpoint snapshots through internal `#engine`, `#types`, and `#services` imports, but those are repository implementation details rather than package guarantees.

Vanilla analyzers created with `forVersion()` for the same requested version string share a backing engine and cache. Calling `resetCaches()` on one of those analyzers clears cache state observed by the others. Mutation-derived analyzers use isolated backing engines.

The published package also exposes `mcenchant` and `mc-enchanting-analyzer` command-line binaries. The CLI is a thin wrapper around `EnchantingAnalyzer`: text output uses `analyze`, `--format json` emits human-readable JSON, and `--raw` / `--format raw-json` emits compact `AnalyzerRawResult`. Everyday calls can use positional inputs:

```bash
mcenchant 1.21 pickaxe diamond 30 --search deep
```

Scripts can use the equivalent explicit flags:

```bash
mcenchant --version 1.21 --item pickaxe --material diamond --xp 30 --search deep
```

CLI version input follows the registry timeline instead of requiring an exact data-boundary version. For example, `1.14.2` uses the rules active before the `1.14.3` protection-conflict boundary, and `1.7.1` uses the rules active before `1.7.2`.

## Request Surface

Stable request fields are the fields used by normal programmatic callers:

| Field | Applies To | Purpose |
|---|---|---|
| `item` | analyze/analyzeRaw | Item key, such as `sword`, `book`, or `pickaxe`. |
| `material` | analyze/analyzeRaw | Material key, such as `diamond`, `book`, or `bow`. |
| `xp` | analyze/analyzeRaw | Player XP level used by the enchanting-table roll. |
| `clue` | analyze/analyzeRaw | Optional exact table clue, such as `Sharpness III`. |
| `search` | analyze/analyzeRaw | Named preset or explicit search controls. |
| `signal` | analyze/analyzeRaw | Abort signal for host UIs. |
| `onProgress` | analyze/analyzeRaw | Progress callback for host UIs. |
| `summaryLimit` | analyze/analyzeRaw | Limit summarized combo rows. |
| `uncappedResults` | analyze/analyzeRaw | Explicitly allow very large summary result sets. |

`search` may be a named preset or a control object:

| Search shape | Purpose |
|---|---|
| `'coarse'`, `'standard'`, `'deep'`, `'ultra'` | Use the same refinement checkpoints as the app. |
| `'exhaustive'` | Search until resolved, aborted, or host resources are exhausted. |
| `{ preset, ...overrides }` | Start from a preset and override specific controls. |
| `{ threshold, maxIterations, targetClassifiedMass, probabilityFloor, drainEqualMassBand, exhaustive, useCache }` | Directly control the engine stop/search behavior. |

Direct checkpoint snapshots and sequential checkpoint streaming remain internal. Public callers get summarized results from the facade instead of raw frontier state.

## Supported Results

Supported result shapes are:

| Type | Purpose |
|---|---|
| `AnalyzerRequest` | Stable request shape for `analyze` and `analyzeRaw`. |
| `AnalyzerSearchPreset` / `AnalyzerSearchControls` | Public search mode controls. |
| `AnalyzerRegistryInfo` | Public high-level registry metadata. |
| `AnalyzerRawResult` | Compact probabilities from `analyzeRaw`. |
| `AnalyzerResult` | Human-readable probabilities from `analyze` or `humanize`. |
| `MassAccountingBreakdown` | Public probability mass buckets, with optional foldable diagnostic details. |

Supported mutation input shapes are:

| Type | Purpose |
|---|---|
| `RegistryMutation` | Union of mutation operations accepted by `forVersion(..., { mutations })` and `withMutations(...)`. |
| `Enchantment`, `EnchantmentLevels` | Enchantment patch shape for `patchEnchantment`. |
| `ConflictRule`, `ConflictRuleSelector` | Add or remove version-ranged enchantment conflict rules. |
| `EnchantmentGroupRule`, `EnchantmentGroupRuleSelector` | Add or remove version-ranged enchantment-group membership rules. |
| `MaterialRule`, `MaterialRuleSelector` | Add or remove version-ranged material keys. |
| `EnchantableItemRule`, `EnchantableItemRuleSelector` | Add or remove item/material/enchantability bindings. |
| `EnchantabilityTable` | Public enchantability category names accepted by item rules. |
| `VersionMechanics` | High-level mechanics flags exposed through `AnalyzerRegistryInfo`. |

`AnalyzerRawResult` keeps compact packed keys for callers that want stable machine-readable IDs. `AnalyzerResult` uses display labels such as `Efficiency IV` and `Efficiency IV+Fortune III` so applications do not need registry internals just to present results.

Result probabilities and folded accounting buckets are part of the supported behavior. Optional accounting details are diagnostic drill-down data and should be folded back to the public buckets for semantic comparisons. The internal tree shape, graph node IDs, checkpoint snapshots, and engine diagnostics are not.

`AnalyzerRegistryInfo` is intentionally small: `version`, `source`, `mechanics`, and `multiEnchantBooks`. Mutation input types describe accepted vanilla-data patches only; the full resolved registry contains packed conflict bitsets, ID maps, and cache-oriented tables that remain internal.

Public API coverage lives in the facade tests and CLI tests. Build-time declarations come from the TypeScript API build, and the generated files are not treated as the support contract.

## Internal And Diagnostic Surface

The following are repository/internal tools. They can change or disappear when the engine implementation changes:

- `SearchResult`, `EngineSearchSnapshot`, frontier views, graph/node IDs, and pending-entry snapshots;
- full resolved registry internals such as conflict bitsets, packed ID maps, and weight tables;
- engine diagnostic counters, instrumentation accumulators, and timing sinks;
- direct imports of `SearchExecutionService`;
- direct imports of `EngineFactory` or `RegistryFactory`;
- direct imports from `src/lib/search/flex/**`;
- direct use of `GroupedFlexSearchRun`, `FlexCoordinator`, `FlexProjector`, or `FlexProgramStore`;
- direct runtime parity scripts and profiling scripts.

## Engine Replacement Policy

The project may replace the internal search runtime in a minor release when the supported API above remains stable:

- callers still create analyzers through `EnchantingAnalyzer`;
- public `AnalyzerRequest` fields keep their meaning;
- `AnalyzerRawResult`, `AnalyzerResult`, and accounting remain compatible;
- public probabilities and accounting stay semantically equivalent;
- internal engine names, diagnostics, and direct search classes may change.

The current search implementation should remain behind the supported API, not become a new product-facing API.

## Release Policy

Minor and major releases must update this file in the final release metadata commit. That update can be a no-op review note when the boundary did not change, but the file should still be touched so reviewers explicitly confirm whether the supported API changed, stayed stable, or reclassified previously experimental surface.

Major releases must also have a human-readable changelog name, using the historical `### The "..." Update` style. The next search-centered major should use a name that describes the model shift, such as `### The "Folded Frontier" Update`.

## References

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) for high-level engine and worker flow.
- [`MASS_HANDLING.md`](../MASS_HANDLING.md) for probability conservation and accounting.
- [`docs/search-engine.md`](search-engine.md) for active search behavior, factorized-tree design, and invariants.
