# Flex Factorized Tree Design

## Common Description

This document records the current Flex/factorized-tree design for the V7 engine line. Flex is an experimental opt-in factorized runtime path: it compresses same-future enchantment alternatives into fixed/choice result programs, moves probability mass through a V7-style coordinator, and projects those programs back into concrete-compatible checkpoint/reporting rows.

The current semantic reference is concrete `SearchRun`, documented in [`docs/v7-shared-search-engine.md`](v7-shared-search-engine.md). Plex is the historical prototype that proved the projection and payload ideas; Flex is the current experiment for carrying those ideas toward the V7 default path. Neither Plex nor Flex is the oracle for correctness.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Current Status](#current-status)
- [Design Goal](#design-goal)
- [Current Flex Implementation](#current-flex-implementation)
- [Plex Lessons Folded into Flex](#plex-lessons-folded-into-flex)
- [Projection Boundary](#projection-boundary)
- [Node and Program Model](#node-and-program-model)
- [Runtime Model](#runtime-model)
- [Correctness Guardrails](#correctness-guardrails)
- [API and Migration Policy](#api-and-migration-policy)
- [Testing Strategy](#testing-strategy)
- [Open Questions](#open-questions)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Purpose / Scope

Flex is an internal search representation and runtime experiment. Its purpose is to reduce structural branching when multiple mutually exclusive enchantment alternatives produce the same future eligibility state, without exposing factorized internals to product callers.

This document covers:

- current opt-in Flex behavior;
- the factorized tree design direction;
- projection/materialization requirements;
- Plex lessons that still matter;
- migration rules for folding Flex into V7 without changing public product contracts.

It does not redefine V7 checkpoint semantics, mass accounting, or worker API behavior. Those live in [`docs/v7-shared-search-engine.md`](v7-shared-search-engine.md).

## Current Status

As of the v7.4.x line, Flex is available as an opt-in experimental/internal backend through `SearchExecutionService` using `searchBackend: 'flex'`. Concrete `SearchRun` remains the default product path and semantic reference. Plex remains available as a legacy experimental comparison backend through `searchBackend: 'plex'`, but new factorized design work should prefer Flex.

Current Flex supports:

- grouped registry graphs that emit fixed factors for singleton edges and choice factors for same-future grouped edges;
- compact `FlexProgramStore` result programs instead of active Plex payload objects on the hot path;
- V7-style best-first mass flow through `FlexCoordinator`;
- resolved program storage without immediate concrete expansion;
- materialized projection to `PackedCombo -> mass` rows;
- concrete-compatible pending-entry projection;
- book-removal projection;
- clue projection;
- split-residue harvesting and mass accounting;
- bounded checkpoint requests with engine-native exit reasons;
- async checkpoint advancement with cooperative yielding and `AbortSignal` handling;
- `searchToCheckpoint`, `searchSequentialCheckpoints`, and `getStats` routing when explicitly requested;
- cached live Flex runs for one-at-a-time refinement calls on the same request signature;
- a default bounded-search probability floor, with `probabilityFloor: 0n` available for concrete-V7 parity diagnostics and `exhaustive: true` disabling the floor;
- reduced structural-key invariant checks for vanilla and adversarial mutated-registry shapes.

Focused parity checks currently cover low-XP grouped Flex sweeps, sampled exhaustive projected result parity, clue-conditioned projection, pending projection, bounded checkpoint shape, probability-floor behavior, service routing, cache behavior, async abort behavior, and reduced-key invariant probes.

## Design Goal

The optimization target is not “a second public engine.” The target is:

```text
V7 runtime semantics + Flex factorized tree structure + concrete-compatible projection
```

Flex should become an internal graph/tree construction and runtime strategy inside V7, not a permanently separate clever backend. The public API should remain stable:

- callers still receive `SearchResult` / `SearchRunSnapshot` compatible outputs;
- workers and UI should not know whether the internal tree is concrete or factorized;
- result materialization remains engine-owned;
- concrete V7 remains available as a comparison and rollback path until Flex has enough parity, safety, and wall-clock evidence.

## Current Flex Implementation

Grouped Flex structural nodes are keyed by:

```ts
(exclusionMask, currentLevel, count)
```

rather than concrete selected-prefix identity:

```ts
(selectedMask, currentLevel)
```

For an eligible entry:

```ts
entry.blocksBitset = entry.idBit | entry.conflictBitset;
childExclusionMask = parentExclusionMask | entry.blocksBitset;
```

When several alternatives produce the same `childExclusionMask`, Flex represents them as one weighted choice emission. For example:

```text
Unbreaking III + (Sharpness IV | Smite IV | Bane of Arthropods IV) + Looting III
```

Projection later materializes the factorized result into concrete rows:

```text
Unbreaking III + Sharpness IV + Looting III
Unbreaking III + Smite IV + Looting III
Unbreaking III + Bane of Arthropods IV + Looting III
```

Flex records emitted factors as compact programs:

```text
FlexProgramStore
  -> fixed emission
  -> choice emission
  -> programId
```

The hot runtime moves mass by graph/node/program IDs. It does not carry mutable rich payload objects, rebuild choice lists on every frontier operation, or materialize concrete combos until a checkpoint/reporting boundary asks for projection.

## Plex Lessons Folded into Flex

Plex proved three useful boundaries:

1. same-future alternatives can be represented as weighted choices;
2. factorized internal results can project back into concrete-compatible rows;
3. the engine needs explicit guards when reduced structural identity is not enough.

Plex also exposed costs Flex is designed to avoid:

- repeated payload construction;
- choice-list canonicalization during hot traversal;
- payload interning/lookups on every frontier merge;
- carrying factorization metadata through paths that only emit singleton factors.

Flex keeps the projection idea, but moves factor construction into graph/program building and keeps runtime closer to concrete V7 mass flow.

Important distinction:

```text
choice program does not imply Plex traversal forever
```

A path may carry an earlier latent choice while later nodes are still cheap singleton appends.

## Projection Boundary

Projection is the successful extraction from the Plex prototype and the main contract Flex preserves.

The engine may internally store compact factorized programs, but public/reporting callers need concrete-compatible rows. Projection is the boundary:

```text
internal Flex result programs
  -> engine-owned projector
  -> concrete PackedCombo rows / pending entries / summaries
```

Projection must know enough to materialize valid combinations:

- ordered fixed enchant factors;
- ordered choice factors and their weighted alternatives;
- book-generated slot/order semantics where book removal can remove one generated slot;
- mass/residue information required for exact accounting;
- canonical IDs for result maps and cache/projection reuse.

Projection should not become the owner of probability decisions. Mass ownership stays inside the engine.

## Node and Program Model

The preferred shape is a generic graph node with a small emitted-factor program, not a mutable rich payload object on each frontier entry.

Illustrative shape:

```ts
type FlexEmission =
  | { kind: 'fixed'; packedEnchant: PackedEnchant }
  | {
      kind: 'choice';
      alternatives: readonly { packedEnchant: PackedEnchant; weight: number }[];
      totalWeight: number;
    };

type FlexProgram = readonly FlexEmission[];

type FlexNode = {
  id: number;
  exclusionMask: bigint;
  currentLevel: number;
  count: number;
  programId: number;
  kind: 'solid' | 'plex';
};
```

The ownership rule is more important than the exact representation:

- graph/tree builder decides child nodes, emitted factors, child `programId`s, and edge weights;
- runtime moves mass through graph/node IDs and records resolved mass by `programId`;
- projection expands `programId -> FlexProgram` only at snapshot/reporting boundaries.

A compact persistent program chain is preferable to storing full arrays per node. The key is that runtime carries stable IDs, not active payload objects.

## Runtime Model

Flex uses a V7-style mass-flow coordinator over factorized nodes:

```text
pop highest-mass node
record stop mass to node.programId
split forward mass across cached edges
push/merge child node mass
```

The hot loop should not:

- rebuild payloads;
- recanonicalize old choice lists;
- materialize concrete combos;
- run projection checks;
- repeatedly inspect old choices when the current edge emits only a singleton.

It still owns probability accounting:

- resolved mass;
- pending mass;
- clue-incompatible mass;
- split residue;
- sieved/capped/overflow buckets;
- conservation diagnostics.

Those ledgers are separate from factorized program representation.

### Runtime as Coordinator

The useful split is not a fully prebuilt graph followed by a separate runner. The graph remains lazy: runtime still discovers structure by asking for expansions as nodes become relevant. The important split is ownership.

```text
factorized graph:     what exists from this node?
frontier:             what should expand next?
mass accountant:      where did the mass go?
compact result store: which program IDs have resolved mass?
checkpoint policy:    should this run continue, stop, abort, or snapshot?
projection:           what public view is needed at this boundary?
```

Projection is not a bolt-on phase after "the engine is done." It is another collaborator the coordinator talks to at checkpoint/view boundaries. The coordinator can keep internal state compact for the hot loop, then ask projection to materialize exactly the view needed for a checkpoint, summary, chart cell, diagnostic dump, or compatibility snapshot.

If the runtime asks questions like "what payload do I append?", "is this old choice still relevant?", "how do I canonicalize this factor list?", or "which concrete rows does this program expand into?", the boundary has leaked. If it only sees node IDs, result/program IDs, edge weights, mass buckets, checkpoint policies, and requested projection views, the split is doing useful work.

## Correctness Guardrails

- Preserve raw active-mass conservation.
- Do not merge by visible combo alone.
- Do not pool residue before mass reaches the same full equivalence point.
- Keep book `removeAdditional` semantics tied to generated slot identity/order.
- Keep clue projection semantically equivalent to concrete combo compatibility.
- Keep public `pendingEntries` concrete-compatible unless an explicit diagnostic API exposes factorized rows.
- Treat non-clique conflict topology as valid unless same-future grouping actually proves alternatives share the same child exclusion state.
- Use `checkFlexReducedKeyInvariant` to prove that reduced structural state determines a projection-equivalent program history for representative vanilla shapes.
- If `(graphId, exclusionMask, currentLevel, count)` no longer determines a projection-equivalent program history, include `programId` in the structural key or use an equivalent conservative fallback for that mode.

Current state: Flex has invariant tests that accept representative vanilla shapes and reject an adversarial mutated sword conflict graph. `SearchExecutionService` now runs that guard for mutated registries and keeps unsafe `searchBackend: 'flex'` requests inside Flex by switching grouped graphs from reduced structural identity to program-aware identity. Reduced mode keys nodes by `(graphId, exclusionMask, currentLevel, count)`; program mode includes `programId` so incompatible histories do not merge.

## API and Migration Policy

Migration should be staged:

1. **Experimental opt-in**: Flex remains behind explicit backend selection with `searchBackend: 'flex'` and comparison tests.
2. **Safety parity**: Flex uses its own mutated-registry guard/fallback behavior for service routing: reduced identity for safe registries, program-aware identity for unsafe ones.
3. **Performance evidence**: benchmark modern books and conflict-heavy item pools across concrete V7, Plex, and Flex.
4. **V7-internal factorized tree**: graph construction emits fixed/choice factors while the runtime remains generic and checkpoint-compatible.
5. **Default internal engine**: after parity, residue diagnostics, mutated-registry safety, and wall-clock benchmarks are acceptable, Flex can become the default implementation.
6. **Concrete fallback/reference**: keep the old concrete path available for debugging and rollback for at least one release window.
7. **Deprecation/removal**: remove the old concrete implementation only when diagnostics show it is no longer needed.

Supported product-facing calls should remain compatible:

```ts
await engine.getStats(request);
await engine.searchToCheckpoint(request);
await engine.searchSequentialCheckpoints(request);
```

Low-level exports such as `SearchRun`, `SearchGraph`, `GroupedFlexSearchRun`, `FlexCoordinator`, and structural diagnostics are technically reachable from the package root. If their contracts change, release notes must classify the change explicitly as internal/advanced, deprecated, or breaking.

## Testing Strategy

Start with cases that isolate the factorization benefit:

- old sword vs modern sword;
- protection armor groups;
- trident non-clique conflict topology;
- mace/spear or other conflict-heavy item pools if present;
- small book cases where exhaustive projection is practical.

Required checks:

- concrete projected result-key parity for exhaustive practical cases;
- mass conservation to `PRECISION`;
- resolved/pending/clue-incompatible bucket equivalence where applicable;
- residue accounting invariants;
- book-removal projection equivalence;
- clue-conditioned output equivalence;
- pending-entry compatibility views;
- async abort/yield behavior;
- reduced structural-key invariant checks for vanilla shapes;
- adversarial mutated-registry checks that force conservative fallback work;
- wall-clock measurements split into graph build, runtime, projection/materialization, and row count.

Books should be benchmarked separately because projection volume can dominate even if search iteration count improves.

## Open Questions

- How much performance overhead does program-aware Flex identity add on adversarial mutated registries, and does it need a cheaper specialized key/index before Flex can become the sole default engine?
- Can fixed/singleton emissions use a denser combo append representation even after an earlier choice factor exists?
- How much current `PlexRun` code survives as reference/prototype after Flex becomes the default factorized implementation?
- Does book projection need streaming/capped materialization for product views?
- What diagnostics should expose structural factorized counts without changing existing public instrumentation meanings?
- When should `searchBackend: 'plex'` be retired or hidden behind narrower diagnostics?

## References / Related Docs

- `docs/v7-shared-search-engine.md` — current V7 engine reference.
- `docs/plex-factorized-tree.md` — historical Plex prototype notes and pointer to this page.
- `ARCHITECTURE.md` — high-level architecture map.
- `MASS_HANDLING.md` — current probability accounting and residue rules.
- `src/lib/search/flex/` — current Flex implementation.
- `src/lib/search/plex/` — historical Plex prototype and comparison implementation.
- `src/lib/search/SearchRun.ts` and `src/lib/search/SearchGraph.ts` — current concrete V7 runtime/graph implementation.

## Owner / Maintainer

Jonathan Braver / V7 engine maintainers.

## Last Updated

2026-05-21
