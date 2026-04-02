# Architecture Map — Minecraft Enchantment Analyzer (v3)

## Entry Points

| Entry point | Purpose |
|---|---|
| `src/index.ts` | Public library API — re-exports engine, registry, data, types, utils |
| `src/ui/index.ts` | Browser UI bundle entry — wires DOM, workers, chart, refinement |
| `src/worker/worker.ts` | Web Worker entry — runs engine off the main thread |

---

## Module Dependency Graph

```
src/data/            ← pure JSON-shaped data (no imports)
  index.ts
  enchantments.ts
  versions.ts
  materials.ts
  cosmetics.ts

src/types/           ← type definitions only (no runtime deps)
  domain.ts
  engine.ts
  serialization.ts
  ui.ts
  index.ts           ← re-exports all types

src/utils/           ← stateless math/format helpers
  math/ProbUtils.ts
  math/BitwiseUtils.ts
  collections/BinaryHeap.ts
  collections/LRUCache.ts
  format/RomanUtils.ts
  format/FormatUtils.ts
  domain/VersionUtils.ts
  domain/ComboUtils.ts
  async/AsyncUtils.ts
  dom/DOMUtils.ts
  index.ts           ← re-exports all utils

src/core/            ← registry construction & shared config
  config.ts          ← ENGINE_DEFAULTS, UI_DEFAULTS, SEARCH_MODES
  factory.ts         ← RegistryFactory  (imports: types, utils, data)
  registry.ts        ← registry lookups (imports: types, utils, config)
  RegistryMaterials.ts (imports: types)
  RegistryPools.ts   (imports: types, utils, config)

src/engine/          ← calculation pipeline
  distribution.ts    (imports: utils, config, types)
  frontier.ts        (imports: utils, config, registry, types)
  search.ts          (imports: utils, registry, config, frontier, types)
  aggregator.ts      (imports: utils, services, registry, config, types, distribution, search, frontier)
  index.ts           (imports: types, utils, registry, factory, config, distribution, search, aggregator)

src/services/        ← post-processing, serialization
  SummaryService.ts  (imports: utils, config, types)
  HumanizationService.ts (imports: utils, registry, types)
  SerializationService.ts (imports: types)
  index.ts           ← re-exports all services

src/worker/          ← Web Worker plumbing
  protocol.ts        ← WorkerRequest / WorkerResponse type definitions
  worker.ts          (imports: engine, data, services, protocol)
  client.ts          (imports: services, protocol, types)

src/ui/              ← browser UI (imports everything above)
  index.ts           ← AppController: wires DOM, workers, chart, refinement
  views/ParamsView.ts
  views/ResultsView.ts
  chart.ts
  chart-manager.ts
  refinement.ts
  theme.ts
```

Dependency direction: `data` ← `types` ← `utils` ← `core` ← `engine` ← `services` ← `worker` ← `ui`
(Each layer imports only from layers to its left, with one noted exception: `engine/aggregator.ts` imports `SummaryService` from `services` for inline progress callbacks.)

---

## Data Flow: Input → Engine → Worker → UI

```
User input (version, category, material, xp, guaranteedFirst)
    │
    ▼
UI (src/ui/index.ts)
  WorkerClient.request('getFullStats', payload)   ← sends message to Web Worker
    │
    ▼  [postMessage over structured clone]
Worker (src/worker/worker.ts)
  engine.getFullStats(cat, xp, mat, config)
    │
    ▼
EnchantEngine.getFullStats  (src/engine/index.ts)
  ├─ validates inputs (xp range, known category/material)
  ├─ checks statsCache
  └─ StatAggregator.getFullStats(registry, cat, xp, mat, guaranteedFirst, config)
        │
        ├─ DistributionService.getModifiedLevelDist(xp, enchantability)
        │    → bigint probability map  { modifiedLevel → P(level) }
        │
        └─ for each modifiedLevel (highest→lowest):
             SearchService.calculateCombinations(registry, cat, ml, mat, ...)
               ├─ FrontierFactory.create()   → initialises BinaryHeap + mass maps
               ├─ best-first search loop:
               │    getEligiblePool()        → PackedEnchant[] for (cat, level, mat)
               │    processInitialNode()     → expand root into first enchants
               │    processSearchNode()      → branch, conflict-prune, merge duplicates
               │    redistributeBookProb()   → split prob for multi-enchant books
               └─ returns SearchFrontier { results, anyMass, rankMass, countMass, uncertainty }

        ↓ accumulate frontier results weighted by modLevel probabilities
        SummaryService.summarize()   → CalculationStats { ranks, any, count, combos, uncertainty }
    │
    ▼
SerializationService.serialize()   → CompactStats (TypedArrays for transferable transfer)
    │
    ▼  [postMessage + transferables]
WorkerClient (src/worker/client.ts)
  SerializationService.deserialize() → CalculationStats
    │
    ├─ onProgress callback → intermediate UI update
    └─ final result
    │
    ▼
UI (HumanizationService.humanize + ResultsView.render + ChartController.update)
```

---

## Key Function Signatures

### `src/engine/index.ts` — `EnchantEngine`
| Signature | What it does |
|---|---|
| `constructor(data, version)` | Builds registry from DATA + version string; throws for invalid inputs |
| `getFullStats(cat, xp, mat, config?) → Promise<CalculationStats>` | Main public API: validates inputs, aggregates stats across all modified levels |
| `calculateCombinations(cat, modLevel, mat, guaranteedFirst?, threshold?, maxIterations?, resultsLimit?) → SearchFrontier` | Runs best-first search for a single modified level; wraps SearchService with cache |
| `getModifiedLevelDist(xp, enchantability) → {[level]: bigint}` | Returns probability distribution over modified enchantment levels |
| `getEligibleListNumeric(cat, level, mat, bitset?) → number[]` | Returns packed enchant IDs eligible at a level, excluding the given bitset |
| `static clearAllCaches()` | Clears all caches across all live engines (keeps engine registry intact) |
| `static clearAllEngines()` | Clears all caches AND removes all engine refs from the global tracking set |
| `destroy()` | Clears caches and removes this engine from the global tracking set |

### `src/engine/aggregator.ts` — `StatAggregator`
| Signature | What it does |
|---|---|
| `static getFullStats(registry, cat, xp, mat, guaranteedFirst?, config?) → Promise<CalculationStats>` | Loops over all modified levels, runs search per level, accumulates weighted mass maps |

### `src/engine/distribution.ts` — `DistributionService`
| Signature | What it does |
|---|---|
| `static getModifiedLevelDist(xp, enchantability, registry, cache?) → {[level]: bigint}` | Computes triangular distribution of modified levels using BigInt fixed-point arithmetic |

### `src/engine/search.ts` — `SearchService`
| Signature | What it does |
|---|---|
| `static calculateCombinations(registry, cat, modLevel, mat, guaranteedFirst?, threshold?, limit, existingFrontier?, resultsLimit?, poolCache?) → SearchFrontier` | Best-first iterative search; resumes from existing frontier if provided |

### `src/engine/frontier.ts` — `FrontierFactory`
| Signature | What it does |
|---|---|
| `static create(registry, cat, modLevel, guaranteedFirst?, existing?, threshold?) → SearchFrontier` | Creates a fresh frontier (with guaranteed-first seed) or deep-clones an existing one |
| `static getGuaranteedFirstId(registry, guaranteedFirst) → number \| null` | Resolves a "Name Rank" string to enchantment ID, returns null if unknown |

### `src/core/factory.ts` — `RegistryFactory`
| Signature | What it does |
|---|---|
| `static build(data, version) → RegistryState` | Builds full registry by resolving version inheritance chain, applying overrides, building ID maps |

### `src/core/registry.ts` — lookup functions
| Signature | What it does |
|---|---|
| `getCategoryId(state, cat) → number` | Returns numeric category ID, or UNKNOWN_CATEGORY_ID (63) if not found |
| `getMaterialId(state, mat) → number` | Returns numeric material ID, or UNKNOWN_MATERIAL_ID (63) if not found |
| `getEnchantId(state, name) → number` | Returns numeric enchantment ID, or UNKNOWN_ENCHANT_ID (255) if not found |
| `isCategoryAvailable(state, cat) → boolean` | True if the category has any enchantments in this version's pool |
| `getEligiblePool(state, cat, level, mat, cache?) → PackedEnchant[]` | Returns packed (id<<8\|rank) list of eligible enchants at the given level |
| `isEnchantmentAchievable(state, fullName, cat, mat, levels, cache?) → boolean` | Checks if a named enchantment appears in any pool for the given levels |
| `getEnchantability(state, mat, cat) → number` | Returns base enchantability value for a material+category combination |

### `src/services/SummaryService.ts`
| Signature | What it does |
|---|---|
| `static summarize(combos, uncertainty, roundingError?, anyMass?, rankMass?, countMass?, comboLimit?) → CalculationStats` | Converts raw BigInt mass maps into a number-based CalculationStats object |

### `src/services/HumanizationService.ts`
| Signature | What it does |
|---|---|
| `static humanize(stats, resolver, sortMode?, romanMap?) → EnchantInsights` | Translates numeric IDs and hex combo keys into human-readable names |

### `src/services/SerializationService.ts`
| Signature | What it does |
|---|---|
| `static serialize(stats) → { compact: CompactStats, transferables: Transferable[] }` | Packs CalculationStats into typed arrays for zero-copy postMessage transfer |
| `static deserialize(compact) → CalculationStats` | Reconstructs CalculationStats from typed array representation |

### `src/worker/client.ts` — `WorkerClient`
| Signature | What it does |
|---|---|
| `init(version) → Promise<void>` | Spawns two Web Workers (main + chart) and initialises each with the given version |
| `request(type, payload, onProgress?, workerTarget?) → Promise<WorkerResult>` | Sends a typed request to the chosen worker; resolves with final stats |

---

## Key Constants (`src/core/config.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `ENGINE_DEFAULTS.MAX_XP_LEVEL` | 50 | Maximum XP level accepted by the engine (covers legacy 1.0 level-50 cap) |
| `UI_DEFAULTS.MAX_XP_LEVEL` | 30 | Maximum level shown in the UI (modern enchanting table cap) |
| `ENGINE_DEFAULTS.UNKNOWN_CATEGORY_ID` | 63 | Sentinel returned by getCategoryId for unknown categories |
| `ENGINE_DEFAULTS.UNKNOWN_MATERIAL_ID` | 63 | Sentinel returned by getMaterialId for unknown materials |
| `ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID` | 255 | Sentinel returned by getEnchantId for unknown enchantments |
| `ENGINE_DEFAULTS.MAX_RESULTS_SIZE` | 5000 | Hard cap on combos stored in a SearchFrontier |
| `ENGINE_DEFAULTS.CACHE_SIZE_COMBO_BOOK` | 64 | LRU size for book combo cache (larger search space) |
| `ENGINE_DEFAULTS.CACHE_SIZE_COMBO_OTHER` | 128 | LRU size for non-book combo cache |
| `ENGINE_DEFAULTS.CACHE_SIZE_STATS` | 8 | LRU size for the unified stats cache |

---

## Caching Layers (inside `EnchantEngine`)

All caches and `_registry` are **private** fields on `EnchantEngine`.

```
distCache      Map<string, {[level]: bigint}>      "xp@enchantability@div@rngRange" → modified level distribution
poolCache      LRUCache<string, PackedEnchant[]>   "cat|level" → eligible enchant list  (mat is NOT in the key)
comboCache     LRUCache<bigint, SearchFrontier>    getPackedKey (includes limit) → search frontier (non-book)
bookComboCache LRUCache<bigint, SearchFrontier>    getPackedKey (includes limit) → search frontier (book)
statsCache     LRUCache<bigint, CalculationStats>  getStatsKey  (no limit, no threshold) → final stats
```

**statsCache semantics**
- Key: `getStatsKey(catId, matId, xp, guaranteedId, resultsLimit)` — no threshold, no limit in key
- Read: return cached entry unconditionally (no quality gate)
- Write: overwrite only if the new result has strictly lower uncertainty than the cached entry

**comboCache / bookComboCache semantics**
- Key: `getPackedKey(catId, matId, modLevel, guaranteedId, limit, resultsLimit)` — limit IS in the key (frontier is limit-specific)
- Read: return cached only if `cached.threshold <= threshold` (i.e. cached search was at least as precise)

**Bit layout of packed keys**

| Bits | Field | Key type |
|------|-------|----------|
| 0–5  | catId | both |
| 6–11 | matId | both |
| 12–19 | modLevel / xp | both |
| 20–27 | guaranteedId | both |
| 28–47 | limit | `getPackedKey` only |
| 28–47 (stats) / 48–63 (combo) | resultsLimit | both (different shift) |
