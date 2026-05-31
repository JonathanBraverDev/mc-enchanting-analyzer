# Rank-Parametric Pool Design Note

## Common Description

This note records the clean rank-merge plan for V8 grouped search. The current prototype branch is useful archaeology for exact rank rehydration, but it should not drive the implementation architecture. The final design must keep graph structure, selected abstract factors, exact ranked pools, and projection ownership separate.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Core Principle](#core-principle)
- [Runtime Identity Glossary](#runtime-identity-glossary)
- [Ownership Boundaries](#ownership-boundaries)
- [Merge Predicate](#merge-predicate)
- [Convergence Model](#convergence-model)
- [Selection Identity](#selection-identity)
- [Rank Pool Resolution](#rank-pool-resolution)
- [Clue Handling](#clue-handling)
- [Implementation Plan](#implementation-plan)
- [Prototype Archaeology](#prototype-archaeology)
- [Acceptance Gates](#acceptance-gates)
- [Open Questions](#open-questions)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Purpose / Scope

The goal is to let grouped search share future structure across modified levels whose pools differ only by exact enchant rank, while preserving exact user-facing result rows, clue behavior, and probability mass accounting.

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

### `selectionId`

`selectionId` identifies the canonical selected abstract state.

It answers:

```text
What selected abstract factors have we accumulated, and through which rank-pool mix?
```

Definition:

```text
selectionId = canonical selected factor set + rankPoolMixId
```

`selectionId` is deliberately not a path. It does not encode traversal order. Two different traversal orders that reach the same selected factor set and the same rank-pool mix must intern to the same `selectionId`.

### Removed Clean-Plan Concepts

Do not use these as clean-plan identities:

- `programId`: overloaded old V8 handle. It mixed selected history, projection identity, and structural reuse pressure.
- `profileId`: prototype compression handle for exact pool signatures.
- `lensId`: old naming for exact modified-level/rank-pool resolution. Use `rankPoolId`.
- `historyId`: too vague. Use `selectionId` for canonical selected state.
- `pathId`: implies traversal order matters. Use `selectionId`.

## Ownership Boundaries

| Concern | Owner |
|---|---|
| Exact modified-level pool construction | `RegistryKernel` / registry lookup |
| Exact ranked pool resolver | rank-pool table keyed by `rankPoolId` |
| Rank-agnostic structural family | family table keyed by `familyId` |
| Structural future state | grouped graph node identity |
| Weighted frontier mass and residue | coordinator/frontier |
| Abstract selected factors | selection/factor store |
| Rank-pool mix internment | selection/factor store or adjacent rank-mix table |
| Exact rank rehydration | projector |
| Diagnostics and probes | run/coordinator diagnostics |

The graph should not own selected exact ranks. The selected-state store should not own future eligibility. The coordinator should not know how to resolve exact packed enchants.

## Merge Predicate

A merged runtime node is valid only when every represented lane already satisfies the merge predicate.

All merged lanes must have:

- the same rank-agnostic enchant ID pool;
- the same canonical selected `factorId` set;
- the same excluded enchant IDs;
- the same effective continuation level;
- the same picked-factor count;
- the same `probContinue` behavior;
- the same remaining structural choices by enchant ID, weight, and conflict behavior;
- the same projection-safe `rankPoolMixId`.

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

## Selection Identity

Selected identity is destination-state identity, not traversal history.

These two paths must resolve to the same selected identity when the rank-pool mix is also the same:

```text
pick Sharpness, then Unbreaking
pick Unbreaking, then Sharpness
```

The selected state should intern factors in canonical order:

```ts
interface SelectionKey {
  readonly rankPoolMixId: number;
  readonly factors: readonly FactorId[]; // canonical sorted order
}
```

The frontier key should therefore be:

```text
(graphNodeId, selectionId)
```

or, if graph identity remains split during migration:

```text
(graphId, graphNodeId, selectionId)
```

It should not be keyed only by graph node. A shared structural node can be reached by multiple selected states that are not mergeable.

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

This is the selected-state identity carried by frontier/residue/projection.

### Phase 6: Re-Key Frontier And Residue

When structural nodes can be shared by multiple selected states, frontier and residue state must include selected identity:

```text
(graphNodeId, selectionId)
```

This avoids the old bug class where graph-node reuse accidentally keeps only the first branch's selected history.

### Phase 7: Enable Structural Node Reuse

Only after rank-pool mix and selection identity exist:

- key graph expansion by structural inputs and `familyId`;
- keep exact rank-pool identity out of structural node keys;
- keep exact rank-pool identity in `rankPoolMixId`;
- let the projector resolve exact packed enchants from rank pools.

This is the first phase expected to reduce graph shape or node counts.

### Phase 8: Start With Singleton Structural Choices

The first real merge can be restricted to singleton structural choices. Conflict/Plex rank mixes can follow after parity and mass checks pass.

This keeps the first implementation small enough to reason about while still validating the ownership model.

### Phase 9: Add Diagnostics

Temporary diagnostics should answer:

- how much modified-level mass was eligible for rank merge;
- how much actually used a merged structural path;
- how much fell back to exact pool handling;
- whether fallback came from non-rank structural differences;
- whether projection produced the same exact snapshots as the non-merged path.

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

2026-05-31
