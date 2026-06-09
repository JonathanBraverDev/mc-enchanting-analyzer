# Rank-Family Merge Plan

## Common Description

This note records the clean rank-family merge plan for V8 grouped search. The current rank-parametric prototype branch is useful archaeology for exact rank rehydration, but it should not drive the implementation architecture. The final design must keep graph structure, selected abstract factors, exact ranked pools, and projection ownership separate.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Core Principle](#core-principle)
- [Runtime Identity Glossary](#runtime-identity-glossary)
- [Ownership Boundaries](#ownership-boundaries)
- [Merge Predicate](#merge-predicate)
- [Convergence Model](#convergence-model)
- [Factor Set And Selection Identity](#factor-set-and-selection-identity)
- [Rank Pool Resolution](#rank-pool-resolution)
- [Mass And Residue Handling](#mass-and-residue-handling)
- [Projection Model](#projection-model)
- [Clue Handling](#clue-handling)
- [Implementation Plan](#implementation-plan)
- [Current Implementation Status](#current-implementation-status)
- [Prototype Archaeology](#prototype-archaeology)
- [Acceptance Gates](#acceptance-gates)
- [Open Questions](#open-questions)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Purpose / Scope

The goal is to let grouped search share rank-family future structure across modified levels whose pools differ only by exact enchant rank, while preserving exact user-facing result rows, clue behavior, and probability mass accounting.

This document is an implementation plan, not a public API contract. It intentionally drops the old `profileId`, `lensId`, and `programId` framing from the clean design. Those names describe prototype mechanics or overloaded V8 internals, not the final ownership model.

## Core Principle

Rank merge is not about forgetting exact ranks.

Rank merge is about moving exact rank ownership out of the graph. The graph should answer "what future abstract choices remain?" The selected-state side should answer "what abstract factors have already been chosen?" The rank-pool side should answer "which exact packed enchant does this abstract enchant resolve to for this modified-level pool?"

In short:

```text
graph structure: rank-agnostic
selected factors: rank-agnostic, order-agnostic
rank pools: exact ranked resolver
projection: exact packed rows
```

The implementation must not store whole pools or exact picked ranks on structural graph nodes.

## Runtime Identity Glossary

### `familyId`

`familyId` identifies a rank-agnostic, order-agnostic future structural search space.

It answers:

```text
Can these lanes share graph expansion from here?
```

It is built from structural enchant facts, not packed ranks or registry list order. Relevant facts include sorted enchant IDs, weights, conflict behavior, exclusion behavior, and continuation-relevant mechanics.

`familyId` replaces only the structural role that old `programId` was sometimes forced to play. It is not selected history, and it is not exact rank identity.

### `rankPoolId`

`rankPoolId` identifies one exact ranked pool resolver.

It answers:

```text
(rankPoolId, enchantId) -> packedEnchant | null
```

The semantic source is the modified-level pool. The runtime may intern identical exact pools behind one `rankPoolId`, but that is storage compression. The design requirement is that projection can recover exact packed enchants from the resolver.

### `rankPoolMixId`

`rankPoolMixId` identifies the weighted set of exact rank pools that currently share an abstract selection state.

It answers:

```text
Which exact rank pools are still represented here, and with what relative weights?
```

The mix is conditional at the selected-state point. Absolute mass remains owned by the coordinator/frontier, not by the mix table.

### `factorId`

`factorId` identifies one abstract picked factor.

A factor is rank-agnostic:

```ts
type FactorId = number & { readonly __brand: 'FactorId' };

interface PickFactor {
  readonly alternatives: readonly PickAlternative[];
}

interface PickAlternative {
  readonly enchantId: number;
  readonly weight: number;
}
```

A solid enchant pick is a one-alternative factor. A conflict/Plex-style pick can be a multi-alternative factor. The factor stores abstract enchant IDs and weights, not packed ranks.

### `factorSetId`

`factorSetId` identifies the canonical selected abstract factor set.

It answers:

```text
What selected abstract factors have we accumulated?
```

`factorSetId` is deliberately not a path. It does not encode traversal order. Two different traversal orders that reach the same selected factor set must intern to the same `factorSetId`.

The frontier merge key uses `factorSetId`, not `selectionId`, so rank-pool mixes can merge when two lanes reach the same structural future with the same abstract picks.

### `selectionId`

`selectionId` identifies the exact projection state.

Definition:

```text
selectionId = factorSetId + rankPoolMixId
```

It is used when exact rank-pool context is required, especially projection and final result ownership.

### Removed Clean-Plan Concepts

Do not use these as clean-plan identities:

- `programId`: overloaded old V8 handle. It mixed selected history, projection identity, and structural reuse pressure.
- `profileId`: prototype compression handle for exact pool signatures.
- `lensId`: old naming for exact modified-level/rank-pool resolution. Use `rankPoolId`.
- `historyId`: too vague. Use `factorSetId` for canonical selected state and `selectionId` for projection state.
- `pathId`: implies traversal order matters. Use `factorSetId`.

## Ownership Boundaries

| Concern | Owner |
|---|---|
| Exact modified-level pool construction | `RegistryKernel` / registry lookup |
| Exact ranked pool resolver | rank-pool table keyed by `rankPoolId` |
| Rank-agnostic structural family | family table keyed by `familyId` |
| Structural future state | grouped graph node identity |
| Weighted frontier mass and residue | coordinator/frontier |
| Abstract selected factors | factor-set store |
| Rank-pool mix internment | selection/factor store or adjacent rank-mix table |
| Exact rank rehydration | projector |
| Diagnostics and probes | run/coordinator diagnostics |

The graph should not own selected exact ranks. The selected-state store should not own future eligibility. The coordinator should not know how to resolve exact packed enchants.

## Merge Predicate

A merged runtime node is valid only when every represented lane already satisfies the merge predicate.

All merged lanes must have:

- the same rank-agnostic enchant ID pool;
- the same canonical selected `factorSetId`;
- the same excluded enchant IDs;
- the same effective continuation level;
- the same picked-factor count;
- the same `probContinue` behavior;
- the same remaining structural choices by enchant ID, weight, and conflict behavior;
- compatible exact rank-pool mixes that can be combined into a new `rankPoolMixId`.

Any deviation makes lanes similar, but not mergeable. Similar lanes may share diagnostics or family analysis, but they cannot be represented as one runtime node.

Once the predicate holds, the merge is absorbing for future structural search. Future structural decisions from that node apply to every exact `rankPoolId` represented by the `rankPoolMixId`.

Exact output ranks are not merged away. Projection still resolves every selected abstract factor through each represented exact rank pool.

## Convergence Model

Different modified levels cannot merge before they have paid any distinct continuation probability that still matters.

Current Flex timing is:

```text
root count 0:
  first pick is guaranteed
  child currentLevel = original modified level

count 1:
  continue chance uses original modified level
  second pick happens if continue succeeds
  child currentLevel = floor(original modified level / divisor)

count 2:
  continue chance uses floor(original modified level / divisor)
  third pick happens if continue succeeds
  child currentLevel = floor(original modified level / divisor / divisor)
```

For modern mechanics with divisor `2`, adjacent levels converge naturally:

```text
12 -> 6
13 -> 6
14 -> 7
15 -> 7
16 -> 8

6 -> 3
7 -> 3
8 -> 4

3 -> 1
4 -> 2
```

So levels `12` and `13` must start as distinct roots, but after the first picked factor they can reach the same continuation level. Levels `14` and `15` can do the same, and later the `6` and `7` groups can converge again.

Small-pool items should benefit most. For a pickaxe-like pool such as:

```text
Efficiency
Unbreaking
Fortune / Silk Touch conflict group
```

paths that pick `Unbreaking` then the `Fortune/Silk Touch` choice, and paths that pick the same factors in the opposite order, should converge once the same abstract factors are present and the same continuation level has been reached.

## Factor Set And Selection Identity

Selected factor-set identity is destination-state identity, not traversal history.

These two paths must resolve to the same factor-set identity:

```text
pick Sharpness, then Unbreaking
pick Unbreaking, then Sharpness
```

The selected factor set should intern factors in canonical order:

```ts
interface FactorSetKey {
  readonly factors: readonly FactorId[]; // canonical sorted order
}
```

The frontier key should therefore be:

```text
(graphNodeId, factorSetId)
```

or, if graph identity remains split during migration:

```text
(graphId, graphNodeId, factorSetId)
```

It should not include `rankPoolMixId`. If the rank-pool mix is part of the frontier key, rank-variant lanes never meet and the optimization is nullified. Instead, a frontier entry carries mass plus `rankPoolMixId`; when another lane reaches the same `(graphId, graphNodeId, factorSetId)`, the coordinator merges mass and combines the rank-pool mixes.

Projection then uses:

```text
selectionId = factorSetId + rankPoolMixId
```

## Rank Pool Resolution

At a given modified level, only one rank of an enchant type can be present in the eligible pool: the highest eligible rank. Projection can therefore resolve exact enchants deterministically:

```text
resolve(rankPoolId, enchantId) -> packedEnchant | null
```

Projection does not need to expand one abstract enchant type into multiple rank possibilities for the same rank pool.

The cost tradeoff remains favorable:

- discovery scans real pool entries and can aggregate them by `enchantId`;
- selected state stores abstract `factorId`s;
- projection pays cached lookups by `(rankPoolId, enchantId)`;
- exact result rows remain recoverable without storing full pools on graph nodes.

If multiple modified levels expose identical exact pools, the runtime may intern them to the same `rankPoolId`.

## Mass And Residue Handling

Rank-pool mix weights are conditional payload weights for the current frontier state. They must move with the same mass split as the frontier entry itself.

This invariant must hold for every pending entry:

```text
entry.mass == sum(rankPoolMix.poolWeights)
```

Using only the initial modified-level probabilities after lanes branch is incorrect. Once a lane takes an edge, the exact-rank payload must represent "how much mass from this exact pool reached this state", not "how much mass this exact pool had at the root".

Example:

```text
root A starts at 60, edge to child has 10% weight -> child contribution A = 6
root B starts at 40, edge to child has 50% weight -> child contribution B = 20
merged child payload = { A: 6, B: 20 }
```

The payload is therefore scaled to child mass before merge. A merge then adds compatible payloads:

```text
same (graphId, graphNodeId, factorSetId):
  mass = left.mass + right.mass
  rankPoolMix = merge(left.rankPoolMix, right.rankPoolMix)
```

Integer mass splitting must match current Flex semantics. Do not distribute remainders to make each split locally exact. Flex floors edge shares, keeps per-frontier-edge residues, and later recovers those residues when the same source frontier key is expanded again.

Rank-family advance follows the same rule, but residue ownership is keyed by the rank-free frontier identity:

```text
residue key = (graphId, graphNodeId, factorSetId)
```

Each residue bucket carries per-`rankPoolId` residue numerators, not one aggregate numerator for the whole merged payload. Recovered rounding must promote per exact rank-pool slice first, then merge the promoted child payload back into the rank-family frontier. If residue numerators are aggregated across rank pools before division, the merged engine can promote units earlier or later than exact Flex.

The conservation invariant becomes:

```text
pendingMass + resolvedMass + overflowMass + roundingLoss == seededMass
```

This is the same mass-harvesting shape as Flex, with the source payload generalized from one exact `programId` to a weighted `rankPoolMixId`. The bookkeeping boundary is:

```text
frontier: merged by (graphId, graphNodeId, factorSetId)
residue bucket: same key, but numerators split by rankPoolId
```

Reopened frontier keys are not counted as new structural iterations. If a late parent sends mass into a key that was already expanded, and that key is the next key the existing max-mass scheduler would pop, the runtime replays that mass through the cached expansion immediately and increments `lateForwardCount`. This preserves Flex-style processing order and integer residue timing while separating:

```text
iterations: first structural frontier expansion for a key
lateForwardCount: cached replay for late mass into an already-expanded key
expansionBuildCount: unique structural expansion construction
```

Do not replace this with count-order/topological batching unless rank-family intentionally adopts a new canonical mass model. Count-order batching eliminates more pending churn, but it changes tiny integer projection parity because stop/continue floors and residue recovery are order-sensitive.

## Projection Model

Projection is the exact-rank boundary for the standalone rank-family runtime.

Input:

```text
selectionId = factorSetId + rankPoolMixId
mass
```

Projection walks the selected abstract factors. For each represented exact rank pool, it resolves every abstract alternative through:

```text
rankPools.resolve(rankPoolId, enchantId) -> packedEnchant | null
```

The projector then packs exact combo rows with the same semantics as `FlexProjector`:

- weighted choices split by factor weights;
- projection loss records integer floor loss;
- book result removal tries every removed slot for multi-enchant books;
- target clues keep only exact packed-rank-compatible rows.

The standalone implementation currently has exact tiny exhaustive parity against current Flex for:

- `1.21.11 sword/diamond XP1`;
- `1.21.11 book/book XP1`.

## Clue Handling

Exact clue-rank pruning belongs at the rank-pool boundary.

If a clue asks for an exact packed enchant and a `rankPoolId` cannot expose that packed enchant for the clue enchant ID, that rank-pool slice is clue-incompatible immediately.

The structural graph should not include exact clue rank in `familyId` or node identity. Clue filtering changes which rank pools are represented in `rankPoolMixId`; it should not force exact rank into the structural graph.

## Implementation Plan

### Phase 1: Establish Clean Names And Types

Introduce or document the clean identity split:

- `familyId`;
- `rankPoolId`;
- `rankPoolMixId`;
- `factorId`;
- `selectionId`.

Remove `programId`, `profileId`, and `lensId` from the new plan vocabulary. They can appear only in migration comments that explain old code.

### Phase 2: Build Order-Agnostic Family Identity

Current family-signature work is useful, but final `familyId` must be order-agnostic.

The final key should canonicalize structural entries by sorted facts such as:

```text
(enchantId, weight, conflictBitset, selfExclusion, continuation-relevant behavior)
```

Registry pool order is not part of the merge predicate.

The existing reversed candidate-order test should flip: reversed candidate order should produce the same final family identity when all structural facts are equal.

### Phase 3: Intern Abstract Pick Factors

Replace exact rank-specific emissions with abstract `factorId`s:

- singleton factor for a single picked enchant ID;
- multi-alternative factor for conflict/Plex-style choices;
- weights preserved on alternatives;
- packed ranks excluded from factor identity.

### Phase 4: Intern Rank Pool Mixes

Create a rank-pool mix table:

```ts
interface RankPoolMix {
  readonly pools: readonly RankPoolWeight[];
}

interface RankPoolWeight {
  readonly rankPoolId: number;
  readonly weight: bigint | number;
}
```

The mix table belongs beside selection/factor storage, not inside graph nodes. Absolute mass remains in the coordinator.

### Phase 5: Intern Selections

Create `selectionId` from:

```text
canonical sorted factorId set + rankPoolMixId
```

This is the selected-state identity carried by projection.

### Phase 6: Re-Key Frontier And Residue

When structural nodes can be shared by multiple selected states, frontier and residue state must include selected identity:

```text
(graphNodeId, factorSetId)
```

or, while graph identity remains split:

```text
(graphId, graphNodeId, factorSetId)
```

The key deliberately excludes `rankPoolMixId`. Exact-rank payloads merge as `rankPoolMixId` values on the frontier entry. Residues use the same rank-free key, with per-edge residue numerators split by exact `rankPoolId`.

This avoids the old bug class where graph-node reuse accidentally keeps only the first branch's selected history, while still allowing exact-rank payloads to converge.

### Phase 7: Enable Structural Node Reuse

Only after rank-pool mix and selection identity exist:

- key graph expansion by structural inputs and `familyId`;
- keep exact rank-pool identity out of structural node keys;
- keep exact rank-pool identity in `rankPoolMixId`;
- let the projector resolve exact packed enchants from rank pools.

This is the first phase expected to reduce graph shape or node counts.

### Phase 8: Project Exact Results

Add a rank-family projector that converts resolved `selectionId` rows into exact `PackedCombo` rows.

The projector must not fake `FlexProgramId`s. It should walk `factorSetId`, resolve alternatives through `RankPoolStore`, and then apply the same result projection semantics as Flex.

### Phase 9: Start With Singleton Structural Choices

The first real merge can be restricted to singleton structural choices. Conflict/Plex rank mixes can follow after parity and mass checks pass.

This keeps the first implementation small enough to reason about while still validating the ownership model.

### Phase 10: Add Diagnostics

Temporary diagnostics should answer:

- how much modified-level mass was eligible for rank merge;
- how much actually used a merged structural path;
- how much fell back to exact pool handling;
- whether fallback came from non-rank structural differences;
- whether projection produced the same exact snapshots as the non-merged path.

## Current Implementation Status

As of 2026-06-09, the implementation branch is `feature/rank-family-merge`.

Pushed slices:

- order-agnostic rank-family signatures while exact pool signatures remain order-sensitive;
- `RankPoolStore` for exact `(rankPoolId, enchantId) -> packedEnchant` resolution;
- `RankSelectionStore` with `FactorId`, `FactorSetId`, `RankPoolMixId`, and `SelectionId`;
- standalone `RankFamilyGraph`;
- standalone `RankFamilySearchRun.advance(maxSteps)`;
- rank-free frontier keys `(graphId, graphNodeId, factorSetId)`;
- mass diagnostics: `seededMass`, `pendingMass`, `resolvedMass`, `overflowMass`, and `roundingLoss`;
- Flex-style frontier residue recovery with per-`rankPoolId` numerator preservation;
- cached late-forward replay for already-expanded frontier keys, reported as `lateForwardCount`;
- `RankFamilyProjector`;
- exact tiny exhaustive projection parity tests for sword and book XP1.

Important correction from implementation:

```text
Do not over-conserve edge splits by distributing integer remainders.
Do not drop residues by simple flooring.
Use Flex-style per-frontier-edge residues, keyed by the rank-free frontier identity.
Within each residue bucket, keep numerators split by rankPoolId.
Replayed late mass may use an existing cached expansion, but only when it is the next key under the same max-mass ordering.
```

Known limitation:

- Exhaustive sword XP10+ now has the same projected combo row set as Flex, but still has tiny integer mass differences on some rows. For `1.21.11 sword/diamond XP30`, the row count matches (`415`), but local comparison still found `124` differing rows with total absolute delta `144` and max row delta `3` after per-rank-pool residue recovery. Cached late-forward replay preserves that known diff while reducing structural iterations from `684` to `383` and reporting `301` late forwards. Do not wire rank-family into the public engine path until the parity difference is explained or eliminated.

Current remaining work:

1. explain or eliminate the remaining exhaustive sword XP10+ tiny integer parity differences;
2. clue-conditioned parity, especially exact-rank clue filtering;
3. pending projection/checkpoint summaries for bounded rank-family runs;
4. opt-in search-mode integration;
5. broader snapshot and performance parity before defaulting to this path.

## Prototype Archaeology

The current `prototype/rank-parametric-pool-factors` branch should be treated as archaeology and proof material only.

Useful salvage:

- exact rank rehydration can work;
- resolver shape similar to `(rankPoolId, enchantId) -> packedEnchant` is viable;
- generic factors are a good direction;
- clue tests around exact ranked clues are valuable;
- current program/factor interning patterns are worth reusing.

Avoid carrying forward:

- `profileId` as a clean-plan concept;
- `lensId` naming;
- `programId` as merged structural identity;
- exact rank/profile identity inside structural graph keys;
- node subclasses for every merge combination;
- storing whole pools on graph nodes;
- order-sensitive family signatures as final merge keys.

## Acceptance Gates

The first real merge should pass:

- normal full snapshot parity against the non-merged path;
- clue snapshot parity, especially exact ranked clues;
- pending/frontier aggregate mass conservation;
- projection mass conservation across projected mass, clue-incompatible mass, and projection loss;
- reversed candidate-order identity test flipped to require equal final `familyId`;
- diagnostics showing eligible, merged, and fallback mass.

## Open Questions

1. Should `rankPoolId` be a branded numeric handle over exact `SearchPoolSignature`, or should it reuse the exact pool signature directly during the first implementation?
2. Should `rankPoolMixId` live inside the selection/factor store or in a small adjacent table owned by the grouped runtime?
3. Should the first implementation be a parallel V8.1-style engine until parity is proven, then replace the current grouped engine?
4. What is the smallest fixture that proves order-agnostic `selectionId` convergence: pickaxe singleton choices, conflict choices, or both?
5. Should conflict/Plex factors be disabled for the first merge implementation even if their factor representation is already generic?

## References / Related Docs

- [`search-engine.md`](search-engine.md)
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Prototype branch: `prototype/rank-parametric-pool-factors`

## Owner / Maintainer

Jonathan Braver

## Last Updated

2026-06-09
