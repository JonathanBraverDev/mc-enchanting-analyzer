# Plex Factorized Tree Design

## Common Description

This document records the experimental Plex/factorized-tree design for the V7 engine line. Plex compresses same-future conflict alternatives into factorized result programs, then projects those programs back into concrete-compatible combo rows at checkpoint/reporting boundaries.

The current V7 engine reference is [`docs/v7-shared-search-engine.md`](v7-shared-search-engine.md). This page is intentionally more speculative and should not be read as current default product behavior.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Current Status](#current-status)
- [Design Goal](#design-goal)
- [Current Prototype](#current-prototype)
- [Problem Found in Profiling](#problem-found-in-profiling)
- [vNext Direction: Factorized Tree Inside V7](#vnext-direction-factorized-tree-inside-v7)
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

Plex is an internal search representation experiment. Its purpose is to reduce structural branching when multiple mutually exclusive enchantment alternatives produce the same future eligibility state.

This document covers:

- current opt-in Plex behavior;
- the factorized tree design direction;
- projection/materialization requirements;
- migration rules for folding the work into V7 without changing public product contracts.

It does not redefine V7 checkpoint semantics, mass accounting, or worker API behavior. Those live in [`docs/v7-shared-search-engine.md`](v7-shared-search-engine.md).

## Current Status

As of the v7.3.x development branch, Plex is available as an opt-in internal backend through `SearchExecutionService` using `searchBackend: 'plex'`. Concrete `SearchRun` remains the default product path.

Current Plex supports:

- aggregate payload choice groups built from same-future conflict alternatives;
- weighted payload factors and reduced choice ratios;
- heap-based best-first frontier advancement;
- resolved Plex payload storage without immediate concrete expansion;
- materialized projection to `PackedCombo -> mass` rows;
- book-removal projection;
- clue projection;
- split-residue harvesting and phase-scoped mass accounting;
- bounded checkpoint requests with engine-native exit reasons;
- `searchToCheckpoint`, `searchSequentialCheckpoints`, and `getStats` routing when explicitly requested;
- cached live Plex runs for one-at-a-time refinement calls on the same request signature.

Focused exhaustive checks matched concrete/projected result-key sets for sampled fully resolved item cases and `1.7.2` book XP 30. Plex can reduce iteration counts substantially, but current wall-clock results are mixed because each Plex iteration is heavier and materialization still has a cost.

## Design Goal

The optimization target is not “a second engine.” The target is:

```text
V7 runtime semantics + factorized tree structure + concrete-compatible projection
```

Plex should eventually be treated as a graph/tree construction strategy inside V7, not a permanently separate clever runtime. The public API should remain stable:

- callers still receive `SearchResult` / `SearchRunSnapshot` compatible outputs;
- workers and UI should not know whether the internal tree is concrete or factorized;
- result materialization remains engine-owned.

## Current Prototype

The current prototype keys Plex structural nodes by:

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

When several alternatives produce the same `childExclusionMask`, Plex can represent them as one weighted choice edge. For example:

```text
Unbreaking III + (Sharpness IV | Smite IV | Bane of Arthropods IV) + Looting III
```

Projection later materializes the factorized result into concrete rows:

```text
Unbreaking III + Sharpness IV + Looting III
Unbreaking III + Smite IV + Looting III
Unbreaking III + Bane of Arthropods IV + Looting III
```

Current frontier invariant: for implemented vanilla search semantics, `(graphId, nodeId)` determines the pending Plex payload. If a future registry/custom topology breaks that invariant, the frontier must fall back to `(graphId, nodeId, payloadId)` identity instead of silently merging different payload expressions.

Registry note: do not require every conflict component to be a clique. Vanilla trident conflicts include `Loyalty — Riptide — Channeling`, where Loyalty and Channeling do not conflict. That topology is valid because the alternatives produce different `blocksBitset` / child exclusion masks and therefore are not squashed into one choice.

## Problem Found in Profiling

Old-vs-modern sword profiling showed that Plex can explode less structurally than concrete V7 but still lose wall-clock time because its runtime is too payload-active.

The main costs to remove from the hot loop are:

- repeated payload construction;
- choice-list canonicalization;
- payload interning/lookups;
- projection preparation;
- carrying factorization metadata through nodes that emit no new choice.

Modern swords make this visible because they add mostly independent dimensions such as Unbreaking and Sweeping Edge. The real search space grows for both concrete V7 and Plex, while current Plex also keeps paying factorized-payload overhead through boring singleton paths.

## vNext Direction: Factorized Tree Inside V7

The next design should use **deferred factorization on a factorized search tree**:

- Build graph/tree nodes that already know their emitted factor/result-program identity.
- Use dense/V7-style traversal for singleton concrete emissions.
- Emit a choice factor only when an expansion groups multiple same-future alternatives.
- After a choice is emitted, keep the factorized result program, but allow later singleton steps to keep using cheap traversal mechanics.
- Keep projection/materialization as the adapter from internal factorized programs to public concrete rows.

Important distinction:

```text
choice payload does not imply Plex traversal forever
```

Payload representation and traversal strategy should be decoupled. A path may carry an earlier latent choice while later nodes are still normal singleton appends.

## Projection Boundary

Projection is the successful extraction from the Plex prototype.

The engine may internally store compact factorized programs, but public/reporting callers need concrete-compatible rows. Projection is the boundary:

```text
internal factorized result programs
  -> engine-owned materializer
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

The preferred vNext shape is a generic graph node with a small emitted-factor program, not a mutable rich payload object on each frontier entry.

Illustrative shape:

```ts
type FactorEmission =
  | { kind: 'fixed'; packedEnchant: PackedEnchant }
  | {
      kind: 'choice';
      alternatives: readonly { packedEnchant: PackedEnchant; weight: number }[];
      totalWeight: number;
    };

type FactorizedProgram = readonly FactorEmission[];

type FactorizedNode = {
  id: number;
  exclusionMask: bigint;
  currentLevel: number;
  count: number;
  programId: number;
  emission: FactorEmission | null;
  probContinue: number;
  edges: readonly { weight: number; childId: number }[];
};
```

The exact representation may differ. The ownership rule should not:

- graph/tree builder decides child nodes, emitted factors, child `programId`s, and edge weights;
- runtime moves mass through node IDs;
- projection expands `programId -> FactorizedProgram` only at snapshot/reporting boundaries.

A compact persistent program chain may be better than storing arrays per node. The key is that runtime carries stable IDs, not active payload objects.

## Runtime Model

A V7-style mass-flow runtime over factorized nodes should be small:

```text
pop highest-mass node
record stop mass to node.programId
split forward mass across cached edges
push/merge child node mass
```

The hot loop should not:

- rebuild payloads;
- recanonicalize choice lists;
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

Those ledgers should be separate from factorized payload/program representation.

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

Under that framing, the runtime is mostly a coordinator between specialized components:

```ts
const work = frontier.popHighestMass();
const expansion = graph.getExpansion(work.nodeId);
const split = massSplitter.splitStopContinue(work.mass, expansion.probContinue);

resultStore.add(expansion.stopProgramId, split.stopMass);
accountant.recordStop(split.stopMass);
frontier.pushOrMerge(expansion.edges, split.forwardMass);
accountant.recordForward(split.forwardMass);

if (checkpointPolicy.shouldSnapshot(runState)) {
  return projector.materialize(runState, checkpointPolicy.requestedView);
}
```

`graph.getExpansion(nodeId)` can lazily create and cache child nodes, child `programId`s, stop/continue probabilities, and edge weights. Program IDs do not imply that the whole graph was built up front; they only mean that when a node or edge is discovered, the graph also records the compact result program that would be visible if mass stops there.

The runtime should communicate among these parts, not own their semantics. If it asks questions like "what payload do I append?", "is this old choice still relevant?", "how do I canonicalize this factor list?", or "which concrete rows does this program expand into?", the boundary has leaked. If it only sees node IDs, result/program IDs, edge weights, mass buckets, checkpoint policies, and requested projection views, the split is doing useful work.

## Correctness Guardrails

- Preserve raw active-mass conservation.
- Do not merge by visible combo alone.
- Do not pool residue before mass reaches the same full equivalence point.
- Keep book `removeAdditional` semantics tied to generated slot identity/order.
- Keep clue projection semantically equivalent to concrete combo compatibility.
- Keep public `pendingEntries` concrete-compatible unless an explicit diagnostic API exposes factorized rows.
- If `(graphId, nodeId)` no longer determines program/payload identity, include `programId`/`payloadId` in the merge key for that mode.
- Treat non-clique conflict topology as valid unless same-future grouping actually proves alternatives share the same child exclusion state.

## API and Migration Policy

Migration should be staged:

1. **Experimental opt-in**: Plex remains behind explicit backend selection and comparison tests.
2. **V7-internal factorized tree**: graph construction emits fixed/choice factors while the runtime remains generic and checkpoint-compatible.
3. **Default internal engine**: after parity, residue diagnostics, and wall-clock benchmarks are acceptable, the factorized tree can become the default implementation.
4. **Concrete fallback/reference**: keep the old concrete path available for debugging and rollback for at least one release window.
5. **Deprecation/removal**: remove the old concrete implementation only when diagnostics show it is no longer needed.

Supported product-facing calls should remain compatible:

```ts
await engine.getStats(request);
await engine.searchToCheckpoint(request);
await engine.searchSequentialCheckpoints(request);
```

Low-level exports such as `SearchRun`, `SearchGraph`, `SearchStateCache`, and structural diagnostics are technically reachable from the package root. If their contracts change, release notes must classify the change explicitly as internal/advanced, deprecated, or breaking.

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
- wall-clock measurements split into graph build, runtime, projection/materialization, and row count.

Books should be benchmarked separately because projection volume can dominate even if search iteration count improves.

## Open Questions

- Should emissions live on nodes, edges, or a persistent program chain?
- When exactly should `programId` become part of node identity?
- Can fixed/singleton emissions use a dense combo append representation even after an earlier choice factor exists?
- How much current `PlexRun` code survives as reference/prototype after the V7-internal factorized tree exists?
- Does book projection need streaming/capped materialization for product views?
- What diagnostics should expose structural factorized counts without changing existing public instrumentation meanings?

## References / Related Docs

- `docs/v7-shared-search-engine.md` — current V7 engine reference.
- `ARCHITECTURE.md` — high-level architecture map.
- `MASS_HANDLING.md` — current probability accounting and residue rules.
- `src/lib/search/plex/` — current prototype implementation.
- `src/lib/search/SearchRun.ts` and `src/lib/search/SearchGraph.ts` — current concrete V7 runtime/graph implementation.

## Owner / Maintainer

Jonathan Braver / V7 engine maintainers.

## Last Updated

2026-05-20
