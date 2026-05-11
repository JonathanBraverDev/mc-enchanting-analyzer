# Function Behavior Inventory

## Common Description

This document records behavior descriptions for the registry/search/engine functions based on reading function parameters and bodies, not current names. It is intended to support the rename/vocabulary cleanup by describing what each function actually does before choosing final names.

## Table of Contents

- [Scope](#scope)
- [Method](#method)
- [Progress](#progress)
- [Behavior Inventory](#behavior-inventory)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Scope

Initial scope covers production functions/methods in:

- `src/lib/search/registry/RegistryKernel.ts`
- `src/lib/search/SearchGraph.ts`
- `src/lib/search/SearchRun.ts`
- `src/lib/search/SearchStateCache.ts`
- `src/lib/search/SearchExecutionService.ts`
- `src/lib/core/registry.ts`
- `src/lib/engine/index.ts`
- `src/lib/engine/cache/CacheManager.ts`

Test helpers can be added later if needed.

## Method

Each section should be filled by a fresh isolated subagent request. The subagent is asked to ignore current naming as much as possible and describe behavior from parameters, control flow, state reads/writes, and return values.

For each function:

- path:line
- current symbol
- inputs/parameters used
- state read/written
- return/side effects
- body-derived behavior summary
- naming notes, if the body contradicts or sharpens the current name

## Progress

- [x] `src/lib/search/registry/RegistryKernel.ts`
- [x] `src/lib/search/SearchGraph.ts`
- [x] `src/lib/search/SearchRun.ts`
- [x] `src/lib/search/SearchStateCache.ts`
- [x] `src/lib/search/SearchExecutionService.ts`
- [x] `src/lib/core/registry.ts`
- [x] `src/lib/engine/index.ts`
- [x] `src/lib/engine/cache/CacheManager.ts`

## Behavior Inventory

### `src/lib/search/registry/RegistryKernel.ts`

- **path:line** `src/lib/search/registry/RegistryKernel.ts:58`
  - **current symbol:** `constructor`
  - **inputs/parameters used:** `request.registry`, `request.item`, `request.material`
  - **state read/written:** reads `request.registry.version`, `request.registry.multiEnchantBooks`; calls `getEnchantability(request.registry, request.material, request.item)`; writes instance fields `registry`, `version`, `item`, `material`, `enchantability`, `multiEnchantBooks`
  - **return/side effects:** initializes request-scoped context state; no explicit return
  - **body-derived behavior summary:** copies request identity/config fields onto the instance and precomputes enchantability for the registry/material/item combination.

- **path:line** `src/lib/search/registry/RegistryKernel.ts:67`
  - **current symbol:** `getPool`
  - **inputs/parameters used:** `level`
  - **state read/written:** reads `poolCache`, `registry`, `item`; calls `getCandidatePool`, `toPoolEntry`, `createPoolSignature`; writes `poolCache`
  - **return/side effects:** returns an immutable `SearchPool`; caches it by modified level
  - **body-derived behavior summary:** reuses a cached pool when present; otherwise fetches the eligible packed enchant list for the item/level, converts each packed enchant into a precomputed entry, sums weights, hashes the structural contents into a signature, freezes the resulting pool, stores it in the per-level cache, and returns it.

- **path:line** `src/lib/search/registry/RegistryKernel.ts:88`
  - **current symbol:** `groupLevelsByPoolSignature`
  - **inputs/parameters used:** `levels`
  - **state read/written:** calls `getPool(level)` for each level; reads each pool's `signature`; builds a local `Map` from signature to `{levels, pool}`
  - **return/side effects:** returns frozen group objects and frozen level arrays; no instance mutation beyond any caching done inside `getPool`
  - **body-derived behavior summary:** partitions the input levels by the structural signature of their computed pools so levels with identical pool contents share one representative pool object and one grouped level list.
  - **naming notes:** the grouping key is the computed pool signature, not the numeric level itself.

- **path:line** `src/lib/search/registry/RegistryKernel.ts:108`
  - **current symbol:** `toPoolEntry`
  - **inputs/parameters used:** `packedEnchant`
  - **state read/written:** reads packing constants, `registry.weightMap`, `registry.enchantToIndex`, `registry.conflictBitsets`, `BIGINT_CONSTANTS.ID_BIT_LOOKUP`
  - **return/side effects:** returns a frozen `SearchPoolEntry`; throws if the derived enchant id has no bigint bit lookup entry
  - **body-derived behavior summary:** decodes the packed enchant into enchant id and rank, looks up search metadata (weight, combo index, conflict bitset, single-id bit), validates that the enchant id is representable in the bigint bit lookup table, and packages the derived fields into an immutable entry.
  - **naming notes:** this is doing both unpacking and metadata augmentation, not just a shallow object creation.

- **path:line** `src/lib/search/registry/RegistryKernel.ts:129`
  - **current symbol:** `createPoolSignature`
  - **inputs/parameters used:** `entries`
  - **state read/written:** reads instance `version`, `item`, `multiEnchantBooks`; reads each entry's `packedEnchant`, `weight`, `comboIndex`, `conflictBitset`; calls `fnv1a64`
  - **return/side effects:** returns a branded `SearchPoolSignature` string
  - **body-derived behavior summary:** serializes registry/item configuration plus each entry's structural search-relevant fields into a `|`-joined string, hashes that serialization with 64-bit FNV-1a, and prefixes the hex digest with `pool:` to produce a stable pool fingerprint.
  - **naming notes:** the signature reflects structural search rules, not the level number directly.

- **path:line** `src/lib/search/registry/RegistryKernel.ts:146`
  - **current symbol:** `fnv1a64`
  - **inputs/parameters used:** `input`
  - **state read/written:** uses local bigint constants `hash`, `prime`, `mask`; reads each UTF-16 code unit with `input.charCodeAt(i)`
  - **return/side effects:** returns a zero-padded 16-character lowercase hex string; no side effects
  - **body-derived behavior summary:** applies the 64-bit FNV-1a hash update per input code unit, constrains the running bigint to 64 bits after each multiply, and formats the final hash as fixed-width hex.
  - **naming notes:** the implementation hashes UTF-16 code units, which is relevant if callers assume byte-level hashing.

### `src/lib/search/SearchGraph.ts`

- **path:line** `src/lib/search/SearchGraph.ts:21`
  - **current symbol:** `NumericGraphNodeIndex.constructor`
  - **inputs/parameters used:** `capacity` (defaulting to `INITIAL_CAPACITY`)
  - **state read/written:** reads static `INITIAL_CAPACITY`, `MAX_LOAD_FACTOR`, and `nextPowerOfTwo`; allocates and writes instance arrays `keys`, `values`, `used`; writes `mask`, `resizeAt`
  - **return/side effects:** initializes empty open-addressed index storage; no explicit return
  - **body-derived behavior summary:** rounds requested capacity up to a power of two, creates parallel typed arrays for numeric keys, node ids, and occupancy flags, seeds value slots with `-1`, and precomputes probing mask and resize threshold.

- **path:line** `src/lib/search/SearchGraph.ts:31`
  - **current symbol:** `NumericGraphNodeIndex.get`
  - **inputs/parameters used:** `key`
  - **state read/written:** reads `mask`, `used`, `keys`, `values`; calls `hash`
  - **return/side effects:** returns a stored node id for an exact key match or `undefined` when probing reaches an unused slot
  - **body-derived behavior summary:** hashes the numeric key to a starting bucket, linearly probes until it finds either the matching key or an empty slot, and treats stored `-1` as absent.

- **path:line** `src/lib/search/SearchGraph.ts:45`
  - **current symbol:** `NumericGraphNodeIndex.set`
  - **inputs/parameters used:** `key`, `value`
  - **state read/written:** reads `count`, `resizeAt`; may call `grow`; calls `insert`
  - **return/side effects:** ensures the index has room, then stores or overwrites the mapping
  - **body-derived behavior summary:** grows the backing table once the load threshold is reached, then delegates actual placement/update to the insertion routine.

- **path:line** `src/lib/search/SearchGraph.ts:50`
  - **current symbol:** `NumericGraphNodeIndex.insert`
  - **inputs/parameters used:** `key`, `value`
  - **state read/written:** reads/writes `used`, `keys`, `values`, `count`, `mask`; calls `hash`
  - **return/side effects:** updates an existing slot for the key or claims a new slot and increments entry count
  - **body-derived behavior summary:** linearly probes from the hashed bucket, replacing the value if the key already exists and otherwise marking the first empty slot as used and filling all parallel arrays.

- **path:line** `src/lib/search/SearchGraph.ts:67`
  - **current symbol:** `NumericGraphNodeIndex.grow`
  - **inputs/parameters used:** none
  - **state read/written:** reads current `keys`, `values`, `used`; writes fresh larger arrays plus `mask`, `resizeAt`, `count`; reinserts old occupied entries via `insert`
  - **return/side effects:** doubles index capacity and rehashes existing contents
  - **body-derived behavior summary:** snapshots the old table, allocates a table twice as large, resets accounting, then reinserts every occupied old slot so probing uses the new mask.

- **path:line** `src/lib/search/SearchGraph.ts:86`
  - **current symbol:** `NumericGraphNodeIndex.hash`
  - **inputs/parameters used:** `key`
  - **state read/written:** local arithmetic only
  - **return/side effects:** returns a mixed unsigned 32-bit hash value
  - **body-derived behavior summary:** splits the numeric key into low/high 32-bit pieces, combines them, and applies several xor/imul avalanche steps before returning a final 32-bit hash.

- **path:line** `src/lib/search/SearchGraph.ts:97`
  - **current symbol:** `NumericGraphNodeIndex.nextPowerOfTwo`
  - **inputs/parameters used:** `value`
  - **state read/written:** local loop only
  - **return/side effects:** returns the smallest power of two greater than or equal to `value`
  - **body-derived behavior summary:** starts at 1 and repeatedly left-shifts until the running size can hold the requested capacity.

- **path:line** `src/lib/search/SearchGraph.ts:164`
  - **current symbol:** `SearchGraph.constructor`
  - **inputs/parameters used:** `context`, `pool`, `options.clueMode`
  - **state read/written:** writes instance `pool`; reads `context.version`, `context.item`, `pool.signature`; calls `getBookMode(context)`; writes frozen `key`
  - **return/side effects:** initializes graph identity metadata for later structural reuse; no explicit return
  - **body-derived behavior summary:** stores the pool and builds an immutable graph cache key from registry version, item, pool signature, derived book mode, and optional clue mode.

- **path:line** `src/lib/search/SearchGraph.ts:180`
  - **current symbol:** `SearchGraph.size`
  - **inputs/parameters used:** none
  - **state read/written:** reads `combos.length`
  - **return/side effects:** returns how many node records have been materialized
  - **body-derived behavior summary:** exposes node count by using the combo array length as the authoritative node storage size.

- **path:line** `src/lib/search/SearchGraph.ts:185`
  - **current symbol:** `SearchGraph.getRootNode`
  - **inputs/parameters used:** `initialLevel`
  - **state read/written:** calls `getOrCreateNodeId` with zero selected mask, zero combo, zero count; calls `getNode`
  - **return/side effects:** returns the root node metadata, creating the root node first when absent
  - **body-derived behavior summary:** treats an empty selection at the requested level as the root identity and reuses the normal node creation/lookup path before returning the node snapshot.

- **path:line** `src/lib/search/SearchGraph.ts:190`
  - **current symbol:** `SearchGraph.getNode`
  - **inputs/parameters used:** `id`
  - **state read/written:** calls `assertNode`; reads `selectedMasks`, `currentLevels`, `combos`, `counts`
  - **return/side effects:** returns a new object containing the stored node fields
  - **body-derived behavior summary:** validates the node id, then packages the parallel-array state for that id into a plain `SearchGraphNode` snapshot.

- **path:line** `src/lib/search/SearchGraph.ts:201`
  - **current symbol:** `SearchGraph.getNodeCombo`
  - **inputs/parameters used:** `id`
  - **state read/written:** calls `assertNode`; reads `combos`
  - **return/side effects:** returns the stored packed combo for the node
  - **body-derived behavior summary:** validates the node id and exposes only its combo field from the internal parallel arrays.

- **path:line** `src/lib/search/SearchGraph.ts:206`
  - **current symbol:** `SearchGraph.getNodeCount`
  - **inputs/parameters used:** `id`
  - **state read/written:** calls `assertNode`; reads `counts`
  - **return/side effects:** returns the stored enchant count for the node
  - **body-derived behavior summary:** validates the node id and exposes only the stored selection count for that node.

- **path:line** `src/lib/search/SearchGraph.ts:212`
  - **current symbol:** `SearchGraph.getExpansion`
  - **inputs/parameters used:** `nodeId`
  - **state read/written:** reads `expansionCache`, `counts`; calls `buildRootExpansion` or `buildSearchExpansion`; writes `expansionCache[nodeId]`
  - **return/side effects:** returns a cached or newly built structural expansion for the node
  - **body-derived behavior summary:** memoizes outgoing-edge structure per node, distinguishing root nodes by `count === 0` and building each expansion lazily only once.

- **path:line** `src/lib/search/SearchGraph.ts:223`
  - **current symbol:** `SearchGraph.buildRootExpansion`
  - **inputs/parameters used:** `nodeId`
  - **state read/written:** reads `currentLevels[nodeId]`, `pool.entries`, `pool.totalWeight`; calls `getOrCreateNodeId`
  - **return/side effects:** returns a root expansion object whose edges point to one-enchant child nodes
  - **body-derived behavior summary:** for every pool entry, creates or reuses the child reached by selecting that single enchant at the same level, then returns an expansion with guaranteed continuation probability, pool total weight, and `no-eligible` only when the pool is empty.

- **path:line** `src/lib/search/SearchGraph.ts:242`
  - **current symbol:** `SearchGraph.buildSearchExpansion`
  - **inputs/parameters used:** `nodeId`
  - **state read/written:** reads node arrays `selectedMasks`, `currentLevels`, `combos`, `counts`; reads `pool.entries`; calls `getTerminalReason`, `createExpansion`, `ComboUtils.packAppendIndex`, `getOrCreateNodeId`; reads `ProbUtils.PROB_CONTINUE_TABLE`
  - **return/side effects:** returns an expansion for a non-root node, possibly terminal with no edges
  - **body-derived behavior summary:** loads the node state, derives whether further selection is blocked by single-book or max-enchant rules, computes continuation probability from level unless single-book forces zero, and otherwise scans pool entries to build child edges only for enchants not already selected and not conflicting, halving the level and appending the new combo index for each child.
  - **naming notes:** this is specifically the non-root expansion builder; the current name is accurate but “search” really means “post-root continuation”.

- **path:line** `src/lib/search/SearchGraph.ts:281`
  - **current symbol:** `SearchGraph.createExpansion`
  - **inputs/parameters used:** `nodeId`, `count`, `probContinue`, `edges`, `terminalReason`, optional `totalWeight`
  - **state read/written:** computes default `totalWeight` from `edges` when omitted
  - **return/side effects:** returns a normalized expansion record
  - **body-derived behavior summary:** packages expansion fields into a consistent object, deriving `isRoot` from `count === 0`, `eligibleCount` from edge length, and optionally summing edge weights when the caller did not precompute total weight.

- **path:line** `src/lib/search/SearchGraph.ts:300`
  - **current symbol:** `SearchGraph.getOrCreateNodeId`
  - **inputs/parameters used:** `selectedMask`, `currentLevel`, `combo`, `count`
  - **state read/written:** calls `createNumericNodeKey`, `numericNodeIndex.get/set`, `createBigIntNodeKey`, `bigintNodeIndex.get/set`; reads/writes `selectedMasks`, `currentLevels`, `combos`, `counts`, `expansionCache`
  - **return/side effects:** returns an existing node id for the structural key or allocates a new one and indexes it
  - **body-derived behavior summary:** chooses a compact numeric key when the mask fits a safe-number range and otherwise a bigint key, reuses an existing node id if that structural key is already indexed, or appends a new node record to the parallel arrays and stores its id in the appropriate index.
  - **naming notes:** despite accepting `combo` and `count`, uniqueness is keyed only by `selectedMask` plus `currentLevel`; the other fields are stored on first creation.

- **path:line** `src/lib/search/SearchGraph.ts:330`
  - **current symbol:** `SearchGraph.createNumericNodeKey`
  - **inputs/parameters used:** `selectedMask`, `currentLevel`
  - **state read/written:** reads static `MAX_NUMERIC_MASK`
  - **return/side effects:** returns a packed numeric key or `undefined` when the mask is too large
  - **body-derived behavior summary:** uses the selected-bitmask directly only when it fits under a safe-number cutoff, packing level into the low 8 bits by multiplying the mask by 256 and adding the level.
  - **naming notes:** this is a conditional pack-to-number helper, not a guaranteed key creator.

- **path:line** `src/lib/search/SearchGraph.ts:335`
  - **current symbol:** `SearchGraph.createBigIntNodeKey`
  - **inputs/parameters used:** `selectedMask`, `currentLevel`
  - **state read/written:** local bigint expression only
  - **return/side effects:** returns a bigint key combining mask and level
  - **body-derived behavior summary:** shifts the selected-bitmask left by 8 bits and inserts the level into the low bits to form a bigint lookup key.

- **path:line** `src/lib/search/SearchGraph.ts:339`
  - **current symbol:** `SearchGraph.getTerminalReason`
  - **inputs/parameters used:** `count`
  - **state read/written:** reads `context.item`, `context.multiEnchantBooks`; reads `ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM`
  - **return/side effects:** returns `'single-book'`, `'max-enchants'`, or `null`
  - **body-derived behavior summary:** blocks continuation after one selection for single-enchant books, otherwise blocks once the global max-enchants limit is reached, and returns `null` when neither terminal rule applies.

- **path:line** `src/lib/search/SearchGraph.ts:349`
  - **current symbol:** `SearchGraph.assertNode`
  - **inputs/parameters used:** `id`
  - **state read/written:** reads `combos.length`
  - **return/side effects:** throws an error for negative or out-of-range ids; otherwise returns nothing
  - **body-derived behavior summary:** enforces that node ids must refer to an existing parallel-array slot before any accessor uses them.

- **path:line** `src/lib/search/SearchGraph.ts:355`
  - **current symbol:** `SearchGraph.getBookMode`
  - **inputs/parameters used:** `context`
  - **state read/written:** reads `context.item`, `context.multiEnchantBooks`
  - **return/side effects:** returns `'item'`, `'multi-book'`, or `'single-book'`
  - **body-derived behavior summary:** classifies graph mode as non-book, multi-enchant book, or single-enchant book solely from the context item type and multi-book flag.

### `src/lib/search/SearchRun.ts`

- **path:line** `src/lib/search/SearchRun.ts:115`
  - **current symbol:** `SearchRun.constructor`
  - **inputs/parameters used:** `context`, `options.distributionService`, `options.graphCache`, `options.targetClueId`
  - **state read/written:** writes instance `context`, `distributionService`, `graphCache`, `targetClueId`; leaves counters/frontier/results initialized from field declarations
  - **return/side effects:** prepares one run with optional injected services/cache; no explicit return
  - **body-derived behavior summary:** stores the search context, prefers an injected modified-level distribution service, and captures optional graph-cache and clue-target settings for later seeding/expansion.

- **path:line** `src/lib/search/SearchRun.ts:125`
  - **current symbol:** `seedXp`
  - **inputs/parameters used:** `xp`; distribution entries from `getModifiedLevelDist`
  - **state read/written:** reads `seeded`, `context.registry`, `context.enchantability`; writes `seeded`, `_seededLevelCount`; reads pools via `context.getPool`; reads/creates graphs via `graphForPool`; records into `mass`; pushes roots into `frontier` via `pushPending`
  - **return/side effects:** seeds pending root nodes once; throws if called twice or if seeded mass exceeds `PRECISION`
  - **body-derived behavior summary:** converts one XP value into modified-level masses, skips zero-mass levels, routes each nonzero level either into clue-incompatible classified mass or into that level's root graph node, tracks how many levels were seeded, and books any underfilled precision remainder as rounding.

- **path:line** `src/lib/search/SearchRun.ts:159`
  - **current symbol:** `searchToCheckpoint`
  - **inputs/parameters used:** optional `request`
  - **state read/written:** calls `createAdvanceCriteria`, `advanceUntilCheckpoint`, `snapshot`
  - **return/side effects:** returns a materialized snapshot after synchronous advancement
  - **body-derived behavior summary:** normalizes checkpoint settings, advances live state until a stopping condition is met, then snapshots the run.

- **path:line** `src/lib/search/SearchRun.ts:166`
  - **current symbol:** `searchToCheckpointAsync`
  - **inputs/parameters used:** optional `request`, especially `yieldEveryIterations`
  - **state read/written:** reads async chunk default from `ENGINE_LIMITS`; calls `createAdvanceCriteria`, repeated `advanceUntilCheckpoint`, `AsyncUtils.yield`, then `snapshot`
  - **return/side effects:** returns a promise of a snapshot after chunked advancement
  - **body-derived behavior summary:** runs the same checkpoint search in scheduler-sized chunks, yielding between chunks so aborts/messages can be observed, and snapshots once a true checkpoint is reached.

- **path:line** `src/lib/search/SearchRun.ts:180`
  - **current symbol:** `createAdvanceCriteria`
  - **inputs/parameters used:** `request.exhaustive`, `request.threshold`, `request.maxIterations`, `request.targetClassifiedMass`, `request.targetResolvedMass`, `request.probabilityFloor`, `request.signal`
  - **state read/written:** reads `seeded`; reads `ENGINE_LIMITS` defaults; converts numeric inputs with `ProbUtils.toBigInt`
  - **return/side effects:** returns normalized stop criteria; throws if search starts before seeding
  - **body-derived behavior summary:** rejects unseeded runs, then converts caller-facing checkpoint settings into an internal criteria object with bigint thresholds/floors and infinite or default iteration limits when exhaustive mode is requested.

- **path:line** `src/lib/search/SearchRun.ts:206`
  - **current symbol:** `advanceUntilCheckpoint`
  - **inputs/parameters used:** `criteria`, optional `chunkIterations`
  - **state read/written:** reads `frontier`, `_iterations`, `mass`; mutates `mass.pending`, frontier contents via `pop`, and run state via `expand`/`_iterations`
  - **return/side effects:** returns `true` when an actual stop boundary is reached, `false` when only the chunk budget is exhausted; throws on abort
  - **body-derived behavior summary:** repeatedly checks abort/frontier emptiness/iteration caps/mass targets/thresholds, pops the highest-mass pending node, removes its pending mass from accounting, expands it, and either finishes at a real checkpoint or yields control when a chunk quota is met.

- **path:line** `src/lib/search/SearchRun.ts:228`
  - **current symbol:** `snapshot`
  - **inputs/parameters used:** none directly; uses `getActiveResidueStats`, `getPendingEntries`
  - **state read/written:** reads `results`, `mass`, `_iterations`, `frontier.size`, `graphs.length`, `_seededLevelCount`; clones `results`; freezes returned object/entries array
  - **return/side effects:** returns an immutable view of current run state without advancing search
  - **body-derived behavior summary:** materializes the public state by copying accumulated results, exporting current mass accounting and counters, exposing pending frontier entries, and summarizing whether unresolved work remains.

- **path:line** `src/lib/search/SearchRun.ts:245`
  - **current symbol:** `expand`
  - **inputs/parameters used:** `graphId`, `nodeId`, `incomingMass`, `probabilityFloor`
  - **state read/written:** reads graph record via `getGraphById`; reads graph expansion/node metadata; delegates to `expandRoot` or `expandSearchNode`
  - **return/side effects:** routes one popped frontier node through the appropriate expansion path
  - **body-derived behavior summary:** fetches the graph/clue policy for a pending node, asks the graph for cached expansion structure, and dispatches root nodes and non-root nodes to different probability-handling logic.

- **path:line** `src/lib/search/SearchRun.ts:267`
  - **current symbol:** `expandRoot`
  - **inputs/parameters used:** `graphId`, `nodeId`, `expansion`, `incomingMass`, `cluePolicy`
  - **state read/written:** reads `expansion.totalWeight`, `expansion.edges`; records resolved mass or delegates to `forwardMass`
  - **return/side effects:** classifies root mass as resolved when nothing is selectable, otherwise forwards it to children
  - **body-derived behavior summary:** treats root nodes with no eligible weighted edges as immediately resolved mass; otherwise distributes the whole incoming mass across first-pick edges using an empty combo baseline.

- **path:line** `src/lib/search/SearchRun.ts:282`
  - **current symbol:** `expandSearchNode`
  - **inputs/parameters used:** `graphId`, `nodeId`, `combo`, `count`, `expansion`, `incomingMass`, `probabilityFloor`, `cluePolicy`
  - **state read/written:** computes with `ProbUtils.scale` and `PRECISION`; records resolved/overflow/sieved mass via `mass`; may call `recordResolved` or `forwardMass`
  - **return/side effects:** splits a non-root node's mass into stop/forward portions and classifies each portion
  - **body-derived behavior summary:** uses the graph continuation probability to resolve the stop share immediately, then either drops, overflows, re-resolves, sieves, or forwards the continuation share depending on terminal reason, edge availability, and the caller's probability floor.

- **path:line** `src/lib/search/SearchRun.ts:317`
  - **current symbol:** `forwardMass`
  - **inputs/parameters used:** `graphId`, `nodeId`, `expansion.edges`, `mass`, `combo`, `cluePolicy`
  - **state read/written:** reads/writes forwarding residue via `getForwardingResidue`/`setForwardingResidue`; updates residue accounting via `recordResidueDelta`; records clue-incompatible mass; pushes child masses into frontier via `pushPending`
  - **return/side effects:** proportionally apportions mass to child nodes, with integer-division residue retained on the parent edge set
  - **body-derived behavior summary:** combines new mass with any saved forwarding residue, divides that total across positive-weight edges by integer weight share, filters out clue-forbidden children after computing their shares, stores the leftover rounding residue back on the parent node, updates rounding bookkeeping, and enqueues allowed child shares.
  - **naming notes:** it distributes only forward mass, not all node outcomes.

- **path:line** `src/lib/search/SearchRun.ts:356`
  - **current symbol:** `getPendingEntries`
  - **inputs/parameters used:** none directly; frontier callback receives `graphId`, `nodeId`, `mass`
  - **state read/written:** iterates `frontier`; reads graph/node metadata through `getGraphById`, `getNodeCombo`, `getNodeCount`; builds frozen entry objects
  - **return/side effects:** returns a new array describing current pending nodes
  - **body-derived behavior summary:** walks the live frontier heap and materializes each pending node's graph id, node id, mass, combo, and enchant count for diagnostics/presentation.

- **path:line** `src/lib/search/SearchRun.ts:371`
  - **current symbol:** `getActiveResidueStats`
  - **inputs/parameters used:** none
  - **state read/written:** reads `forwardingResidues`
  - **return/side effects:** returns `{count, mass}` for nonzero residue cells
  - **body-derived behavior summary:** scans all per-graph residue arrays, counting only nonzero entries and summing their retained forwarding residue.

- **path:line** `src/lib/search/SearchRun.ts:385`
  - **current symbol:** `recordResidueDelta`
  - **inputs/parameters used:** `oldResidue`, `newResidue`
  - **state read/written:** records or subtracts from `mass.rounding`; records `mass.recoveredRounding`
  - **return/side effects:** adjusts accounting for residue growth or recovery
  - **body-derived behavior summary:** treats residue increases as newly trapped rounding mass, and residue decreases as recovered rounding that is removed from the rounding bucket and added to a separate recovered-rounding bucket.

- **path:line** `src/lib/search/SearchRun.ts:398`
  - **current symbol:** `getForwardingResidue`
  - **inputs/parameters used:** `graphId`, `nodeId`
  - **state read/written:** reads `forwardingResidues[graphId][nodeId]`
  - **return/side effects:** returns stored residue or `0n` when that graph/node has never stored one
  - **body-derived behavior summary:** looks up a parent node's saved integer-division remainder in the per-graph residue table with a zero default.

- **path:line** `src/lib/search/SearchRun.ts:403`
  - **current symbol:** `setForwardingResidue`
  - **inputs/parameters used:** `graphId`, `nodeId`, `residue`
  - **state read/written:** reads/writes `forwardingResidues`; allocates or expands `BigUint64Array` storage sized by node index; writes residue slot
  - **return/side effects:** ensures per-graph residue storage exists and stores the node residue
  - **body-derived behavior summary:** lazily creates or doubles residue arrays until they can address the target node id, then writes that node's saved forwarding remainder.

- **path:line** `src/lib/search/SearchRun.ts:424`
  - **current symbol:** `containsTargetClue`
  - **inputs/parameters used:** `combo`, `cluePolicy`
  - **state read/written:** reads `context.registry.indexToEnchant`; calls `cluePolicy.containsTargetClue`
  - **return/side effects:** returns whether the combo includes the target clue under registry lookup mapping
  - **body-derived behavior summary:** delegates clue membership testing to the clue policy using the registry's enchant-index-to-id mapping.

- **path:line** `src/lib/search/SearchRun.ts:428`
  - **current symbol:** `recordResolved`
  - **inputs/parameters used:** `combo`, `count`, `mass`, `cluePolicy`
  - **state read/written:** reads `context.item`; may call `containsTargetClue`, `ComboUtils.removeAdditional`, `ProbUtils.addItemMass`; writes `results`; records `resolved`, `clueIncompatible`, or `rounding` buckets in `mass`
  - **return/side effects:** classifies resolved probability into result combos or incompatible/rounding buckets
  - **body-derived behavior summary:** ignores zero mass, rejects clue-mismatching outcomes, redistributes multi-enchant book combos across `removeAdditional` variants with integer division and remainder handling, and otherwise records the combo's mass directly (except combo `0`, which still counts as resolved but is not inserted into `results`).
  - **naming notes:** this is doing result normalization and clue filtering, not just a simple “settle”.

- **path:line** `src/lib/search/SearchRun.ts:480`
  - **current symbol:** `pushPending`
  - **inputs/parameters used:** `graphId`, `nodeId`, `mass`
  - **state read/written:** writes `frontier` through `pushOrMerge`; records `mass.pending`
  - **return/side effects:** no-ops for zero mass; otherwise enqueues/merges pending work and accounts for it
  - **body-derived behavior summary:** skips empty shares, then adds the node mass into the max-heap frontier and mirrors that addition in pending-mass accounting.

- **path:line** `src/lib/search/SearchRun.ts:486`
  - **current symbol:** `graphForPool`
  - **inputs/parameters used:** `pool`
  - **state read/written:** reads/writes `graphsBySignature`, `graphs`, `targetClueId`, `graphCache`, `context.registry`; may call `ClueSearchPolicy.create`; may call `graphCache.getOrCreateGraph` or `new SearchGraph`
  - **return/side effects:** returns a cached graph record for the pool signature or creates/freeze-stores one
  - **body-derived behavior summary:** reuses an existing graph record for matching pool signatures, otherwise derives the pool's initial packed enchants, optionally builds a clue policy for the target clue, obtains or constructs the structural graph, assigns the next numeric graph id, freezes the record, and caches it by signature.
  - **naming notes:** this is “get or create by pool signature,” not a plain accessor.

- **path:line** `src/lib/search/SearchRun.ts:504`
  - **current symbol:** `getGraphById`
  - **inputs/parameters used:** `graphId`
  - **state read/written:** reads `graphs`
  - **return/side effects:** returns the stored graph record; throws if the id is unknown
  - **body-derived behavior summary:** validates that a numeric graph id was registered and exposes its graph/clue-policy record.

- **path:line** `src/lib/search/SearchRun.ts:523`
  - **current symbol:** `SearchRunFrontier.size`
  - **inputs/parameters used:** none
  - **state read/written:** reads `heapNodeIds.length`
  - **return/side effects:** returns current heap entry count
  - **body-derived behavior summary:** exposes frontier size by using heap length as the authoritative count.

- **path:line** `src/lib/search/SearchRun.ts:527`
  - **current symbol:** `SearchRunFrontier.pushOrMerge`
  - **inputs/parameters used:** `graphId`, `nodeId`, `mass`
  - **state read/written:** ensures storage for the graph/node; reads/writes per-node `masses` and `positions`; appends to `heapGraphIds`/`heapNodeIds`; may call `bubbleUp`
  - **return/side effects:** merges mass into an existing heap entry or inserts a new heap entry
  - **body-derived behavior summary:** uses per-graph typed-array storage to detect whether a node is already in the frontier, adding mass and reheaping in place when it is, or appending a new heap slot and recording its back-pointer when it is not.

- **path:line** `src/lib/search/SearchRun.ts:545`
  - **current symbol:** `SearchRunFrontier.peekMass`
  - **inputs/parameters used:** none
  - **state read/written:** reads `heapNodeIds.length`; calls `massAt(0)` when nonempty
  - **return/side effects:** returns the largest pending mass or `0n` for an empty frontier
  - **body-derived behavior summary:** peeks the root of the max-heap without removal.

- **path:line** `src/lib/search/SearchRun.ts:549`
  - **current symbol:** `SearchRunFrontier.forEach`
  - **inputs/parameters used:** `callback`
  - **state read/written:** iterates `heapGraphIds`/`heapNodeIds`; reads masses via `getNodeMass`
  - **return/side effects:** invokes the callback once per heap entry in internal heap-array order
  - **body-derived behavior summary:** walks all currently queued heap entries and exposes each entry's graph id, node id, and stored mass without sorting beyond existing heap layout.

- **path:line** `src/lib/search/SearchRun.ts:557`
  - **current symbol:** `SearchRunFrontier.pop`
  - **inputs/parameters used:** mutable `out`
  - **state read/written:** reads/writes heap arrays and per-graph storage; clears popped node mass/position; may move last heap entry to root and `sinkDown`
  - **return/side effects:** fills `out` with the highest-mass frontier entry and removes it from the heap; returns `false` when empty
  - **body-derived behavior summary:** removes the heap root, copies its graph/node/mass into the caller-provided object, clears that node's storage slot, then restores max-heap order by moving the last entry to the top and sinking it.

- **path:line** `src/lib/search/SearchRun.ts:582`
  - **current symbol:** `SearchRunFrontier.bubbleUp`
  - **inputs/parameters used:** `index`
  - **state read/written:** reads heap entry ids/mass; moves parent entries down with `moveHeapEntry`; rewrites final heap slot and position back-pointer for the lifted node
  - **return/side effects:** restores max-heap order upward from an insertion/merge point
  - **body-derived behavior summary:** caches the moved node, repeatedly compares it against parents by mass, shifts larger-gap parents downward until heap order is satisfied, then stores the cached node in its final position.

- **path:line** `src/lib/search/SearchRun.ts:600`
  - **current symbol:** `SearchRunFrontier.sinkDown`
  - **inputs/parameters used:** `index`
  - **state read/written:** reads child masses via `massAt`; moves larger child entries upward with `moveHeapEntry`; rewrites final heap slot and position back-pointer for the sunk node
  - **return/side effects:** restores max-heap order downward from the root/replacement point
  - **body-derived behavior summary:** caches the displaced node, repeatedly selects the heavier child, shifts that child upward while it outweighs the cached node, and finally writes the cached node into the first valid heap position.

- **path:line** `src/lib/search/SearchRun.ts:624`
  - **current symbol:** `SearchRunFrontier.moveHeapEntry`
  - **inputs/parameters used:** `from`, `to`
  - **state read/written:** reads heap entry ids from `from`; writes them into `to`; updates the node's position back-pointer in graph storage
  - **return/side effects:** copies one heap entry to another slot while keeping back-pointers consistent
  - **body-derived behavior summary:** performs the low-level heap-slot move used by bubble/sink operations and synchronizes the typed-array position index for the moved node.

- **path:line** `src/lib/search/SearchRun.ts:632`
  - **current symbol:** `SearchRunFrontier.massAt`
  - **inputs/parameters used:** `index`
  - **state read/written:** reads heap graph/node ids at that heap slot; calls `getNodeMass`
  - **return/side effects:** returns the stored mass for the heap entry at the given heap index
  - **body-derived behavior summary:** resolves a heap slot into its graph/node identity and then looks up that node's mass in graph-specific storage.

- **path:line** `src/lib/search/SearchRun.ts:636`
  - **current symbol:** `SearchRunFrontier.getNodeMass`
  - **inputs/parameters used:** `graphId`, `nodeId`
  - **state read/written:** reads `storages[graphId].masses[nodeId]`
  - **return/side effects:** returns the mass stored for one graph/node frontier entry
  - **body-derived behavior summary:** provides the direct typed-array lookup underlying heap comparisons and iteration.

- **path:line** `src/lib/search/SearchRun.ts:640`
  - **current symbol:** `SearchRunFrontier.ensureStorage`
  - **inputs/parameters used:** `graphId`, `nodeId`
  - **state read/written:** reads/writes `storages`; may call `createStorage` or `growStorage`
  - **return/side effects:** returns graph-specific typed-array storage large enough for the node index
  - **body-derived behavior summary:** lazily allocates per-graph mass/position arrays at at least initial capacity and expands them when a node id exceeds current bounds.

- **path:line** `src/lib/search/SearchRun.ts:654`
  - **current symbol:** `SearchRunFrontier.createStorage`
  - **inputs/parameters used:** `capacity`
  - **state read/written:** calls `nextPowerOfTwo`; allocates/fills `Int32Array` positions and `BigUint64Array` masses
  - **return/side effects:** returns empty storage with all positions initialized to `-1`
  - **body-derived behavior summary:** rounds requested capacity to a power of two, creates zeroed mass storage, and creates a parallel position map whose unused slots are explicitly marked absent.

- **path:line** `src/lib/search/SearchRun.ts:664`
  - **current symbol:** `SearchRunFrontier.growStorage`
  - **inputs/parameters used:** `storage`, `required`
  - **state read/written:** allocates larger arrays, copies old masses/positions, resets new position tail to `-1`, then overwrites `storage.masses`/`storage.positions`
  - **return/side effects:** mutates the provided storage object to larger backing arrays
  - **body-derived behavior summary:** expands graph storage to the next power of two that can hold the required node id while preserving existing masses and position back-pointers.

- **path:line** `src/lib/search/SearchRun.ts:675`
  - **current symbol:** `SearchRunFrontier.nextPowerOfTwo`
  - **inputs/parameters used:** `value`
  - **state read/written:** local loop only
  - **return/side effects:** returns the smallest power of two at least as large as `value`
  - **body-derived behavior summary:** repeatedly doubles from 1 until the requested capacity fits.

### `src/lib/search/SearchStateCache.ts`

- **path:line** `src/lib/search/SearchStateCache.ts:41`
  - **current symbol:** `constructor`
  - **inputs/parameters used:** `config.graphSize`, `config.runSize`
  - **state read/written:** allocates and writes instance caches `graphs` and `runs`; reads fallback capacities `256` and `128`
  - **return/side effects:** initializes two LRU partitions; no explicit return
  - **body-derived behavior summary:** builds separate LRU caches for structural graphs and resumable runs, using caller-provided capacities when present and fixed defaults otherwise.

- **path:line** `src/lib/search/SearchStateCache.ts:47`
  - **current symbol:** `getOrCreateGraph`
  - **inputs/parameters used:** `context`, `pool`, `clueMode`
  - **state read/written:** calls `createSearchGraphKey`; reads/writes `graphs`; increments `metrics.graphs.hits` or `metrics.graphs.misses`; may instantiate `SearchGraph`
  - **return/side effects:** returns a cached or newly created `SearchGraph`, and updates graph-cache hit/miss counters
  - **body-derived behavior summary:** derives a structural cache key from context, pool signature, and clue mode, reuses the stored graph on hit, or creates/stores a new graph for that key on miss.

- **path:line** `src/lib/search/SearchStateCache.ts:62`
  - **current symbol:** `getOrCreateRun`
  - **inputs/parameters used:** `key`, `create`
  - **state read/written:** reads/writes `runs`; increments `metrics.runs.hits` or `metrics.runs.misses`; invokes `create()` only on miss
  - **return/side effects:** returns a cached or newly created `SearchRun`, and updates run-cache hit/miss counters
  - **body-derived behavior summary:** looks up one resumable run by caller-supplied key, reuses it when present, and otherwise materializes a run through the callback, stores it, and returns it.

- **path:line** `src/lib/search/SearchStateCache.ts:75`
  - **current symbol:** `clearRuns`
  - **inputs/parameters used:** none
  - **state read/written:** clears `runs`; resets `metrics.runs`
  - **return/side effects:** drops all cached runs and zeroes only run hit/miss counters
  - **body-derived behavior summary:** wipes the run partition without touching cached graphs, then resets just the run metrics bucket.

- **path:line** `src/lib/search/SearchStateCache.ts:80`
  - **current symbol:** `clearAll`
  - **inputs/parameters used:** none
  - **state read/written:** clears `graphs` and `runs`; calls `resetMetrics`
  - **return/side effects:** drops both cache partitions and zeroes all counters
  - **body-derived behavior summary:** fully clears both cached state layers, then delegates metric reset so both graph and run counters go back to zero.

- **path:line** `src/lib/search/SearchStateCache.ts:86`
  - **current symbol:** `resetMetrics`
  - **inputs/parameters used:** none
  - **state read/written:** overwrites `metrics.graphs` and `metrics.runs`
  - **return/side effects:** zeroes all hit/miss counters without clearing cache contents
  - **body-derived behavior summary:** resets metric state only, leaving any cached graph and run entries intact.

- **path:line** `src/lib/search/SearchStateCache.ts:91`
  - **current symbol:** `getMetrics`
  - **inputs/parameters used:** none
  - **state read/written:** reads `metrics.graphs` and `metrics.runs`
  - **return/side effects:** returns a snapshot object with shallow-copied stats; no cache mutation
  - **body-derived behavior summary:** exposes current hit/miss counts as a detached snapshot so callers receive copies rather than the live metric objects.

- **path:line** `src/lib/search/SearchStateCache.ts:98`
  - **current symbol:** `createSearchGraphKey`
  - **inputs/parameters used:** `context.version`, `context.item`, `context.multiEnchantBooks`, `pool.signature`, `clueMode`
  - **state read/written:** reads context and pool fields only; computes local `bookMode`
  - **return/side effects:** returns a JSON string key; no mutation
  - **body-derived behavior summary:** classifies the request as item, multi-book, or single-book mode from the context, then serializes version, item, pool signature, derived book mode, and clue mode into one stable graph-cache key string.
  - **naming notes:** this is specifically a cache-key serializer for graph reuse, not a general graph identifier.

### `src/lib/search/SearchExecutionService.ts`

- **path:line** `src/lib/search/SearchExecutionService.ts:17`
  - **current symbol:** `constructor`
  - **inputs/parameters used:** optional `distributionService`, optional `cache`
  - **state read/written:** writes instance fields `distributionService` and `cache`, defaulting to new service/cache instances when arguments are omitted
  - **return/side effects:** initializes the execution service with injectable distribution and cache dependencies; no explicit return
  - **body-derived behavior summary:** stores the two collaborators that later create seeded runs and provide graph/run reuse.

- **path:line** `src/lib/search/SearchExecutionService.ts:23`
  - **current symbol:** `clearCache`
  - **inputs/parameters used:** none
  - **state read/written:** calls `this.cache.clearAll()`
  - **return/side effects:** clears both structural graph and resumable run caches owned by the service
  - **body-derived behavior summary:** delegates full cache reset to the shared search-state cache.

- **path:line** `src/lib/search/SearchExecutionService.ts:28`
  - **current symbol:** `searchToCheckpoint`
  - **inputs/parameters used:** `request.timing`, `request.exhaustive`, `request.threshold`, `request.maxIterations`, `request.signal`, `request.instrumentation`
  - **state read/written:** reads service cache/run state via `getRun`; advances the run with `run.searchToCheckpointAsync`; mutates `request.timing` through `finishTiming`; may populate instrumentation in `toSearchResult`
  - **return/side effects:** returns one checkpoint/final result for the request
  - **body-derived behavior summary:** gets or creates the matching seeded run, advances it once using zero threshold and unbounded iterations for exhaustive mode or request/default limits otherwise, records elapsed timing when requested, and converts the snapshot into a public result.

- **path:line** `src/lib/search/SearchExecutionService.ts:44`
  - **current symbol:** `searchSequentialCheckpoints`
  - **inputs/parameters used:** `request.checkpoints`, `request.signal`, each checkpoint's `threshold`, `limit`, `targetClassifiedMass`, plus `request.onCheckpointComplete`, `request.instrumentation`, `request.timing`
  - **state read/written:** reads or creates the run via `getRun`; repeatedly advances the same run; mutates `request.timing` via `finishTiming`; may mutate instrumentation via `toSearchResult`
  - **return/side effects:** streams each completed checkpoint to `request.onCheckpointComplete` and returns the last completed result or an empty/current snapshot result
  - **body-derived behavior summary:** reuses one run across an ordered checkpoint plan, stops early on abort, skips missing checkpoint entries, tolerates an abort raised during a search chunk by returning the last completed result when available, and otherwise snapshots current run state if no checkpoint completed.
  - **naming notes:** the method both advances sequential checkpoints and emits per-checkpoint callbacks, so “stream checkpoints on one run” is the practical behavior.

- **path:line** `src/lib/search/SearchExecutionService.ts:81`
  - **current symbol:** `getRun`
  - **inputs/parameters used:** `request.useCache` and the full `request` through `createRun`/`createRunCacheKey`
  - **state read/written:** may bypass or use `this.cache.getOrCreateRun(...)`
  - **return/side effects:** returns a fresh or cached seeded `SearchRun`
  - **body-derived behavior summary:** builds a run factory, skips cache reuse only when `useCache === false`, and otherwise looks up a resumable run under a structural request key.

- **path:line** `src/lib/search/SearchExecutionService.ts:87`
  - **current symbol:** `createRun`
  - **inputs/parameters used:** `request.registry`, `request.item`, `request.material`, `request.targetClueId`, `request.xp`
  - **state read/written:** constructs `RegistryKernel`; constructs `SearchRun` with instance `distributionService` and `cache`; calls `run.seedXp(request.xp)`
  - **return/side effects:** returns a newly seeded run ready for checkpoint advancement
  - **body-derived behavior summary:** creates the registry/material/item context, wires in shared distribution and graph-cache dependencies plus optional clue targeting, seeds the run from the requested XP, and hands back the initialized run.

- **path:line** `src/lib/search/SearchExecutionService.ts:102`
  - **current symbol:** `createRunCacheKey`
  - **inputs/parameters used:** `request.registry.version`, `request.item`, `request.material`, `request.xp`, `request.targetClueId`
  - **state read/written:** reads request fields only
  - **return/side effects:** returns a JSON string cache key
  - **body-derived behavior summary:** serializes the request identity needed to safely reuse a seeded run, including a fixed schema version and explicit `null` when no target clue is set.
  - **naming notes:** this is specifically a seeded-run reuse key, not a full request fingerprint, since threshold/iteration settings are intentionally excluded.

- **path:line** `src/lib/search/SearchExecutionService.ts:113`
  - **current symbol:** `toSearchResult`
  - **inputs/parameters used:** `snapshot`, `threshold`, optional `targetClassifiedMass`, optional `instrumentation`, optional `timing`
  - **state read/written:** converts thresholds with `ProbUtils`; reads `snapshot.mass`, `snapshot.iterations`, `snapshot.results`, `snapshot.pendingCount`, `snapshot.largestPendingMass`, `snapshot.activeResidue*`, `snapshot.graphCount`, `snapshot.seededLevelCount`, `snapshot.fullyResolved`; reads cache metrics from `this.cache.getMetrics()`; mutates the passed `instrumentation` object before cloning it
  - **return/side effects:** returns a `SearchResult` with copied combos and shallow-cloned instrumentation/timing snapshots
  - **body-derived behavior summary:** derives bigint threshold/classified-mass cutoffs, computes classified mass as total precision minus pending mass, fills instrumentation fields and exit reason from snapshot and cache metrics when requested, and packages the snapshot with detached result maps and metadata.
  - **naming notes:** besides conversion, this method also finalizes instrumentation and exit-reason reporting.

- **path:line** `src/lib/search/SearchExecutionService.ts:169`
  - **current symbol:** `finishTiming`
  - **inputs/parameters used:** optional `timing`, `start`, `alreadyRecordedForCall`
  - **state read/written:** reads `performance.now()`; mutates `timing.searchMs` and `timing.totalMs` when timing is present
  - **return/side effects:** returns total elapsed milliseconds since `start`; otherwise returns the prior recorded amount unchanged when no timing object exists
  - **body-derived behavior summary:** measures total elapsed time for the current service call, subtracts any amount already recorded for earlier checkpoints in the same call, accumulates only the new delta into search/total timing buckets, and reports the updated elapsed baseline for later iterations.

### `src/lib/core/registry.ts`

- **path:line** `src/lib/core/registry.ts:12`
  - **current symbol:** `getEligibleMaterials`
  - **inputs/parameters used:** `state`, `item`
  - **state read/written:** reads `state.itemMaterials[item]`, `state.materialPriority`; calls `sortMaterials`; no writes
  - **return/side effects:** returns a new sorted array of compatible materials
  - **body-derived behavior summary:** reads the item's material list or `[]`, clones it, then sorts the clone by registry priority order with lexical fallback.

- **path:line** `src/lib/core/registry.ts:20`
  - **current symbol:** `isMaterialEligible`
  - **inputs/parameters used:** `state`, `item`, `material`
  - **state read/written:** reads `state.itemMaterials[item]`; no writes
  - **return/side effects:** returns boolean
  - **body-derived behavior summary:** checks whether the item's declared material list contains the given material, defaulting missing items to an empty list.

- **path:line** `src/lib/core/registry.ts:31`
  - **current symbol:** `getEnchantName`
  - **inputs/parameters used:** `state`, `id`
  - **state read/written:** reads `state.revIdMap[id]`; no writes
  - **return/side effects:** returns the mapped enchant name; throws for unknown ids
  - **body-derived behavior summary:** performs reverse id lookup and fails loudly when no name is registered.

- **path:line** `src/lib/core/registry.ts:43`
  - **current symbol:** `getRankRoman`
  - **inputs/parameters used:** `state`, `rank`
  - **state read/written:** reads `state.romanMap`; calls `RomanUtils.rankToRoman`
  - **return/side effects:** returns roman numeral text for the rank
  - **body-derived behavior summary:** delegates rank formatting to the roman utility using the registry's numeral map.

- **path:line** `src/lib/core/registry.ts:53`
  - **current symbol:** `getItemId`
  - **inputs/parameters used:** `state`, `item`
  - **state read/written:** reads `state.itemIdMap`, `ENGINE_LIMITS.UNKNOWN_ITEM_ID`
  - **return/side effects:** returns known item id or unknown sentinel
  - **body-derived behavior summary:** looks up an item id in the registry map and substitutes the engine's unknown-item constant when absent.

- **path:line** `src/lib/core/registry.ts:63`
  - **current symbol:** `getMaterialId`
  - **inputs/parameters used:** `state`, `material`
  - **state read/written:** reads `state.materialIdMap`, `ENGINE_LIMITS.UNKNOWN_MATERIAL_ID`
  - **return/side effects:** returns known material id or unknown sentinel
  - **body-derived behavior summary:** looks up a material id and falls back to the unknown-material constant.

- **path:line** `src/lib/core/registry.ts:73`
  - **current symbol:** `getEnchantId`
  - **inputs/parameters used:** `state`, `name`
  - **state read/written:** reads `state.idMap`, `ENGINE_LIMITS.UNKNOWN_ENCHANT_ID`
  - **return/side effects:** returns known enchant id or unknown sentinel
  - **body-derived behavior summary:** maps enchant name to id with a sentinel fallback instead of throwing.

- **path:line** `src/lib/core/registry.ts:84`
  - **current symbol:** `hasConflict`
  - **inputs/parameters used:** `state`, `idA`, `idB`
  - **state read/written:** reads `state.conflictBitsets[idA]`; no writes
  - **return/side effects:** returns boolean
  - **body-derived behavior summary:** tests whether enchant `idB`'s bit is set inside `idA`'s conflict bitset, treating missing bitsets as zero.

- **path:line** `src/lib/core/registry.ts:94`
  - **current symbol:** `isItemAvailable`
  - **inputs/parameters used:** `state`, `item`
  - **state read/written:** reads `state.itemPool[item]`; no writes
  - **return/side effects:** returns boolean
  - **body-derived behavior summary:** reports whether the item has a pool entry with at least one enchant name.

- **path:line** `src/lib/core/registry.ts:105`
  - **current symbol:** `getItemPool`
  - **inputs/parameters used:** `state`, `item`
  - **state read/written:** reads `state.itemPool[item]`; no writes
  - **return/side effects:** returns the stored pool array or `[]`
  - **body-derived behavior summary:** exposes the item's enchant-name pool directly, defaulting missing items to an empty list.

- **path:line** `src/lib/core/registry.ts:115`
  - **current symbol:** `getFullEnchantName`
  - **inputs/parameters used:** `state`, `idAndRank`
  - **state read/written:** decodes packed bits; calls `getEnchantName`, `getRankRoman`
  - **return/side effects:** returns `"name rank"` display text
  - **body-derived behavior summary:** unpacks the high bits as enchant id and low byte as rank, then concatenates the looked-up name and romanized rank.

- **path:line** `src/lib/core/registry.ts:133`
  - **current symbol:** `getCandidatePool`
  - **inputs/parameters used:** `state`, `item`, `level`, optional `cache`, optional `version`
  - **state read/written:** reads cache via `cache.getPool`; reads `state.itemPool[item]`, `state.resolvedRegistry`, `state.idMap`, `state.sortedRanks`; may write cache via `cache.setPool`
  - **return/side effects:** returns packed `(id << shift) | rank` entries; throws for unknown items; may populate cache
  - **body-derived behavior summary:** reuses a cached pool by `item|level` when both cache and version are supplied; otherwise walks the item's enchant names, skips missing registry props, and for each enchant chooses the first matching rank from descending `sortedRanks`, which makes the emitted rank the highest achievable one at that level. Multiple different enchantments can appear for the same modified level; lower overlapping ranks of the same enchantment are intentionally not emitted for that level.
  - **rule source:** `src/lib/core/factory.ts` sorts ranks descending, then `src/lib/core/registry.ts` scans those ranks and `break`s after the first range match. This encodes “highest matching rank per enchantment per modified level.” Minecraft Wiki's `Enchanting table mechanics` page says that if the modified level is within two overlapping ranges for the same enchantment type, the higher power value is used.
  - **naming notes:** this computes one packed highest-rank candidate per enchantment at a specific modified level, not a generic “all eligible ranks” pool.

- **path:line** `src/lib/core/registry.ts:168`
  - **current symbol:** `getAvailablePool`
  - **inputs/parameters used:** `state`, `item`, `level`, optional `bitset`, optional `cache`, optional `version`
  - **state read/written:** calls `getCandidatePool`; reads `PACKING_CONSTANTS.ENCHANT_SHIFT`; no writes
  - **return/side effects:** returns the full pool or a filtered subset
  - **body-derived behavior summary:** fetches the packed eligible pool and, unless the exclusion bitset is zero, removes entries whose unpacked enchant id already has a bit set in that bitset.
  - **naming notes:** behavior is “eligible pool minus excluded enchant ids”; `Numeric` mainly reflects the bigint bitset filter, not the returned values.

- **path:line** `src/lib/core/registry.ts:185`
  - **current symbol:** `isEnchantmentAchievable`
  - **inputs/parameters used:** `state`, `fullName`, `item`, `levels`, optional `cache`, optional `version`
  - **state read/written:** parses with `EnchantUtils.parse`; reads `state.romanMap`, `state.idMap`; calls `getCandidatePool`; reads packing constants
  - **return/side effects:** returns boolean
  - **body-derived behavior summary:** parses a display string into enchant name/rank, rejects unparseable or unknown names, then checks each supplied modified level until one pool contains an exact packed id/rank match.

- **path:line** `src/lib/core/registry.ts:206`
  - **current symbol:** `getEnchantability`
  - **inputs/parameters used:** `state`, `material`, `item`
  - **state read/written:** calls `isMaterialEligible`; reads `state.version`, `state.itemEnchantability[item]`, `state.materialValues[tableName]`, `table[material]`
  - **return/side effects:** returns numeric enchantability; throws for incompatible material, unknown item, or missing material value
  - **body-derived behavior summary:** first enforces that the material is valid for the item in this registry version, then resolves the item's enchantability table name and returns that table's value for the material.
  - **naming notes:** this is specifically registry-table lookup with validation, not a computed formula.

- **path:line** `src/lib/core/registry.ts:218`
  - **current symbol:** `sortMaterials`
  - **inputs/parameters used:** `priors`, `mats`
  - **state read/written:** mutates `mats` via in-place `sort`; reads `priors.indexOf(...)`; uses `localeCompare`
  - **return/side effects:** returns the same array instance after sorting in place
  - **body-derived behavior summary:** orders materials by explicit priority positions when present, puts prioritized entries before unprioritized ones, and alphabetizes ties/unlisted materials.
  - **naming notes:** helper is in-place on the passed array; callers that need immutability must clone first, as `getEligibleMaterials` does.

### `src/lib/engine/index.ts`

- **path:line** `src/lib/engine/index.ts:20`
  - **current symbol:** `EnchantEngine.registry`
  - **inputs/parameters used:** none
  - **state read/written:** reads instance field `_registry`; no writes
  - **return/side effects:** returns the stored registry object reference
  - **body-derived behavior summary:** exposes the engine's injected registry state unchanged through a getter.

- **path:line** `src/lib/engine/index.ts:22`
  - **current symbol:** `EnchantEngine.constructor`
  - **inputs/parameters used:** `registry`, `cache`, `distributionService`, optional `searchService`
  - **state read/written:** writes `_registry`; parameter properties store `cache`, `distributionService`, and `searchService`; if `searchService` is omitted, constructs `new SearchExecutionService(distributionService)`
  - **return/side effects:** initializes engine dependencies; no explicit return
  - **body-derived behavior summary:** captures the registry and service dependencies, defaulting the search service to one built from the provided distribution service so calculation/search share the same distribution logic.

- **path:line** `src/lib/engine/index.ts:32`
  - **current symbol:** `EnchantEngine.resetCaches`
  - **inputs/parameters used:** none
  - **state read/written:** calls `cache.clearAll()` and `searchService.clearCache()`
  - **return/side effects:** clears engine cache layers managed by both collaborators
  - **body-derived behavior summary:** requests a full reset of the direct engine caches and also the search service's cached run/graph state.
  - **naming notes:** plural is warranted because it clears two cache-owning collaborators, not just one store.

- **path:line** `src/lib/engine/index.ts:35`
  - **current symbol:** `EnchantEngine.getCacheMetrics`
  - **inputs/parameters used:** none
  - **state read/written:** reads metrics through `cache.getEngineMetrics()`
  - **return/side effects:** returns a metrics snapshot object from the cache manager
  - **body-derived behavior summary:** delegates cache hit/miss reporting to the cache manager without adding engine-local metrics.

- **path:line** `src/lib/engine/index.ts:40`
  - **current symbol:** `EnchantEngine.destroy`
  - **inputs/parameters used:** none
  - **state read/written:** no reads or writes beyond the comment
  - **return/side effects:** no-op
  - **body-derived behavior summary:** intentionally does nothing; teardown does not clear shared caches or release dependencies.
  - **naming notes:** the body is an explicit no-op placeholder, so the name suggests stronger teardown semantics than are currently implemented.

- **path:line** `src/lib/engine/index.ts:47`
  - **current symbol:** `EnchantEngine.getModifiedLevelDist`
  - **inputs/parameters used:** `xp`, `enchantability`, optional `instrumentation`
  - **state read/written:** reads `registry`, `cache`, `distributionService`; passes `instrumentation` through
  - **return/side effects:** returns the modified-level probability map produced by the distribution service
  - **body-derived behavior summary:** forwards the current registry, request inputs, cache, and optional instrumentation to the injected distribution service.

- **path:line** `src/lib/engine/index.ts:54`
  - **current symbol:** `EnchantEngine.getAvailablePool`
  - **inputs/parameters used:** `item`, `level`, optional `bitset` defaulting to `0n`
  - **state read/written:** reads `_registry`, `cache`, `_registry.version`; no writes
  - **return/side effects:** returns the registry helper's filtered packed-enchant list
  - **body-derived behavior summary:** asks the registry helper for the eligible packed enchants at one level, optionally excluding entries whose enchant ids are already present in the provided bigint bitset.

- **path:line** `src/lib/engine/index.ts:63`
  - **current symbol:** `EnchantEngine.searchSequentialCheckpoints`
  - **inputs/parameters used:** `request`, especially `item`, `material`, optional `clue`, and `checkpoints`
  - **state read/written:** calls `prepareSearchRequest`; then calls `searchService.searchSequentialCheckpoints(...)`
  - **return/side effects:** returns the search service result for the sequential checkpoint plan
  - **body-derived behavior summary:** shares validation and registry/clue context preparation with the other public engine search APIs, then forwards the prepared request into sequential checkpoint execution.

- **path:line** `src/lib/engine/index.ts:70`
  - **current symbol:** `EnchantEngine.searchToCheckpoint`
  - **inputs/parameters used:** `request`, especially `item`, `material`, optional `clue`
  - **state read/written:** calls `prepareSearchRequest`; then calls `searchService.searchToCheckpoint(...)`
  - **return/side effects:** returns one checkpoint/final raw search result
  - **body-derived behavior summary:** validates and prepares the public request, attaches the active registry and optional packed clue id, then advances one checkpoint request through the search service.

- **path:line** `src/lib/engine/index.ts:79`
  - **current symbol:** `EnchantEngine.getStats`
  - **inputs/parameters used:** `request`, including item/material/xp search config, optional clue, optional threshold/maxIterations, optional summaryLimit, instrumentation, and timing
  - **state read/written:** calls `getDefaultStatsCheckpoint`; calls `prepareSearchRequest`; reads `registry.indexToEnchant`; calls `searchService.searchToCheckpoint(...)`; calls `SummaryService.summarize(...)` or `SummaryService.summarizeConditioned(...)`; may update `request.timing.postProcessingMs` and `request.timing.totalMs`
  - **return/side effects:** returns summarized `EnchantStats` with search instrumentation and timing attached
  - **body-derived behavior summary:** provides the simple public stats API by filling missing threshold/iteration settings from the shared default stats checkpoint, using the same checkpoint search path as raw search callers, then converting the raw `SearchResult` into presented stats without a separate stats cache or alternate search route.

- **path:line** `src/lib/engine/index.ts:107`
  - **current symbol:** `EnchantEngine.prepareSearchRequest`
  - **inputs/parameters used:** `request.item`, optional `request.clue`, and all request fields forwarded by spread
  - **state read/written:** calls `validateRequest`; may call `getPackedClue`; reads `registry`
  - **return/side effects:** returns a request copy with `registry` and optional `targetClueId` attached
  - **body-derived behavior summary:** centralizes public request validation and clue packing so raw checkpoint APIs and summarized stats use the same prepared search context.

- **path:line** `src/lib/engine/index.ts:117`
  - **current symbol:** `EnchantEngine.getPackedClue`
  - **inputs/parameters used:** `item`, `clue`
  - **state read/written:** reads `registry`; calls `ClueValidator.validate(...)`
  - **return/side effects:** returns a numeric packed clue id; throws when validation fails
  - **body-derived behavior summary:** validates the clue string against the current registry/item context and returns the packed clue representation used by the search layer.

- **path:line** `src/lib/engine/index.ts:121`
  - **current symbol:** `EnchantEngine.validateRequest`
  - **inputs/parameters used:** `request.item`, `request.material`, `request.xp`, optional `request.threshold`, `request.maxIterations`, optional `request.checkpoints`, optional `request.resultsLimit`
  - **state read/written:** reads `registry.mechanics.xp_cap`, `registry.version`; falls back to `MINECRAFT_RULES.XP_CAP_LEGACY`; calls `isItemAvailable`, `isMaterialEligible`, `ProbUtils.toNumber`; iterates `request.checkpoints` when present; no writes
  - **return/side effects:** throws descriptive errors for invalid request fields; otherwise returns nothing
  - **body-derived behavior summary:** enforces positive integer XP within the version-specific cap, requires an available item/material pairing, validates threshold and checkpoint target masses as numbers between 0 and 1, requires positive integer `maxIterations`, and bounds `resultsLimit` to 1 through 1,000,000.
  - **naming notes:** this is full request-shape/range validation across multiple request types, not just a lightweight sanity check.

### `src/lib/engine/cache/CacheManager.ts`

- **path:line** `src/lib/engine/cache/CacheManager.ts:20`
  - **current symbol:** `constructor`
  - **inputs/parameters used:** `config.poolSize`
  - **state read/written:** writes instance `pool`; leaves `dist` and `metrics` at field-initialized defaults
  - **return/side effects:** initializes the pool LRU cache; no explicit return
  - **body-derived behavior summary:** creates the pool cache with caller-supplied capacity while relying on field initializers for the distribution map and zeroed metrics.

- **path:line** `src/lib/engine/cache/CacheManager.ts:25`
  - **current symbol:** `getDist`
  - **inputs/parameters used:** `version`, `key`
  - **state read/written:** reads `dist`; increments `metrics.dist.hits` or `metrics.dist.misses`
  - **return/side effects:** returns the stored level-to-bigint distribution object or `undefined`
  - **body-derived behavior summary:** looks up a distribution entry under a `version:key` string and updates the distribution hit/miss counter based on whether the map returned a truthy value.

- **path:line** `src/lib/engine/cache/CacheManager.ts:30`
  - **current symbol:** `setDist`
  - **inputs/parameters used:** `version`, `key`, `val`
  - **state read/written:** writes `dist`
  - **return/side effects:** stores the provided distribution object under the composed cache key
  - **body-derived behavior summary:** concatenates version and key with `:` and writes the passed distribution map into the plain `Map` cache.

- **path:line** `src/lib/engine/cache/CacheManager.ts:35`
  - **current symbol:** `getPool`
  - **inputs/parameters used:** `version`, `key`
  - **state read/written:** reads `pool`; increments `metrics.pool.hits` or `metrics.pool.misses`
  - **return/side effects:** returns the cached packed-enchant array or `undefined`
  - **body-derived behavior summary:** fetches a pool entry from the LRU cache using the same `version:key` scheme and records a hit or miss from the returned value.

- **path:line** `src/lib/engine/cache/CacheManager.ts:40`
  - **current symbol:** `setPool`
  - **inputs/parameters used:** `version`, `key`, `val`
  - **state read/written:** writes `pool`
  - **return/side effects:** inserts or refreshes one pool-cache entry in the LRU store
  - **body-derived behavior summary:** stores the packed-enchant array in the pool LRU cache under the composed string key.

- **path:line** `src/lib/engine/cache/CacheManager.ts:45`
  - **current symbol:** `clearAll`
  - **inputs/parameters used:** none
  - **state read/written:** clears `dist` and `pool`; calls `resetMetrics`
  - **return/side effects:** removes cached entries and zeroes counters
  - **body-derived behavior summary:** wipes every cache partition regardless of backend type, then delegates to the shared metric reset routine.

- **path:line** `src/lib/engine/cache/CacheManager.ts:51`
  - **current symbol:** `resetMetrics`
  - **inputs/parameters used:** none
  - **state read/written:** overwrites `metrics.dist` and `metrics.pool`
  - **return/side effects:** zeroes all hit/miss counters without clearing cache contents
  - **body-derived behavior summary:** replaces each metrics bucket with a fresh `{ hits: 0, misses: 0 }` object, leaving cached values intact.

- **path:line** `src/lib/engine/cache/CacheManager.ts:56`
  - **current symbol:** `getMetrics`
  - **inputs/parameters used:** none
  - **state read/written:** reads `metrics.dist` and `metrics.pool`
  - **return/side effects:** returns a detached snapshot keyed as `dist` and `pool`
  - **body-derived behavior summary:** exposes current metrics through shallow copies so callers cannot mutate the live counter objects through the returned structure.

- **path:line** `src/lib/engine/cache/CacheManager.ts:66`
  - **current symbol:** `getEngineMetrics`
  - **inputs/parameters used:** none
  - **state read/written:** reads `metrics.dist` and `metrics.pool`
  - **return/side effects:** returns a detached snapshot keyed as `distCache` and `poolCache`
  - **body-derived behavior summary:** repackages the same two metric buckets under engine-instrumentation field names while still cloning each counter object before returning it.
  - **naming notes:** this does not compute different metrics; it only renames the output fields for a public consumer.

<!-- Fresh-subagent results get appended below. -->

## References / Related Docs

- `docs/search-function-inventory.md`
- `docs/v7-shared-search-engine.md`

## Owner / Maintainer

Jonathan Braver / Thing 2

## Last Updated

2026-05-11
