# Rank-Parametric Pool Design Note

## Common Description

This note records the design conclusion from the rank-parametric pool prototype branch. It explains why the original idea clashes with the V8 grouped-search implementation, and how the refined modified-level lens model can fit the current architecture with less ownership churn.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Current V8 Ownership](#current-v8-ownership)
- [Original Idea Conflict](#original-idea-conflict)
- [Refined Model](#refined-model)
- [Exact Enchant Resolution](#exact-enchant-resolution)
- [Rank Merge Goal](#rank-merge-goal)
- [Convergence Model](#convergence-model)
- [Order-Agnostic Pick History](#order-agnostic-pick-history)
- [Current Prototype Mismatch](#current-prototype-mismatch)
- [Ownership Boundaries](#ownership-boundaries)
- [Merge Plan](#merge-plan)
- [What To Salvage](#what-to-salvage)
- [Open Questions](#open-questions)
- [Implementation Direction](#implementation-direction)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Purpose / Scope

The goal is to let grouped search share more future structure across rank-equivalent enchant choices without losing exact output fidelity. This document is not the V8 runtime contract. It is branch-level design context for comparing the pushed rank-parametric prototype with a cleaner follow-up implementation.

## Current V8 Ownership

V8 separates future search state from generated result history:

- `GroupedFlexGraph` owns structural node identity: exclusion mask, current level, count, and `programId`.
- `FlexProgramStore` owns generated result history behind each `programId`.
- `FlexProjector` resolves program history into exact user-facing combo rows and aggregates.
- `RegistryKernel` owns exact pool construction and modified-level pool signatures.

Nodes do not store the enchants selected so far. A node stores enough state to continue discovery, plus a `programId` that points to selected-history data.

## Original Idea Conflict

The original rank-mux idea treated nodes as if they could directly carry:

- the active pool;
- solid picked enchants;
- Plex choices;
- enough information to later resolve abstract choices like `sharpness` into exact ranked enchants.

That clashes with V8 in two ways.

First, putting pools and picks into nodes makes node identity own projection history. V8's graph nodes are meant to describe future eligibility, while programs describe already-generated result factors.

Second, putting full pools into nodes splits ownership. The graph already owns pool-derived structure, and the kernel owns pool construction. Node-level pool storage would add a third place that needs to agree with both.

## Refined Model

The refined model keeps V8's ownership split and uses modified level as the pool lens.

Each weighted search root already comes from a modified level. That modified level defines the exact eligible bucket for projection. Different modified levels may share the same graph structure when their future behavior is equivalent, but the original modified level remains the semantic key for exact enchant recovery.

The intended program-history record is a canonical set of generic pick factors plus a profile/lens set:

```ts
interface ProgramHistoryKey {
  readonly profileSetId: number;
  readonly factors: readonly PickFactorId[];
}

type PickFactorId = number & { readonly __brand: 'PickFactorId' };

interface PickFactor {
  readonly alternatives: readonly PickAlternative[];
}

interface PickAlternative {
  readonly enchantId: number;
  readonly weight: number;
}
```

A solid transition is a factor with one alternative. A Plex/conflict transition is a factor with multiple alternatives. The profile set says which modified-level lenses can resolve those abstract factors. The model does not need separate rank-specific emission variants.

## Exact Enchant Resolution

At a given modified level, only one rank of an enchant type can be present in the eligible pool: the highest eligible rank. That invariant is important.

It means projection can resolve exact enchants deterministically:

```ts
exactEnchant(modifiedLevel, enchantId) -> packedEnchant | null
```

Projection does not need to expand one abstract enchant type into multiple rank possibilities for the same modified level. It only rehydrates the exact ranked enchant that the pool for that modified level exposes.

This keeps the main cost tradeoff favorable:

- discovery still scans real pool entries and can aggregate them by `enchantId`;
- program history can store abstract type-level factors;
- projection pays a cached lookup by `(profileId/modifiedLevel, enchantId)`;
- exact result rows remain recoverable without storing full pools on nodes.

If multiple modified levels share identical eligible buckets, caching can later use a pool or bucket signature. The semantic key should remain modified level unless and until equivalence is proven.

## Rank Merge Goal

Rank merge is not primarily about storing rank-less enchants. It is about letting modified levels with rank-only pool differences share future graph shape.

Example:

```text
Level 14 pool: Sharpness III, Bane IV, Smite IV, ...
Level 15 pool: Sharpness IV, Bane IV, Smite IV, ...
```

For search continuation, choosing Sharpness from either pool can have the same structural effect:

- same enchant ID;
- same weight;
- same self exclusion;
- same conflict exclusion;
- same next-level/count transition.

Only the exact packed rank differs. That difference belongs to selected-history projection, not future graph shape.

The rank merge is successful only if both statements stay true:

- the graph can reuse structural nodes across rank profiles;
- exact result rows, clue behavior, and pending aggregates still resolve to exact packed enchants.

## Convergence Model

The continue check is tied to `currentLevel`, so different modified levels cannot merge before they have paid any distinct continue probability that still matters.

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

For modern mechanics where the divisor is `2`, adjacent levels converge naturally:

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

So levels `12` and `13` must start as distinct roots, but after the first picked factor they can reach the same continuation level. Levels `14` and `15` do the same, and later the `6` and `7` groups can converge again.

A rank-merged node is valid when every represented modified-level profile has reached the same structural continuation state:

- same `currentLevel`;
- same picked-factor count;
- same excluded enchant IDs;
- same remaining structural entries by `enchantId`, weight, and conflict behavior;
- same rational continuation behavior from this point forward.

Exact packed ranks are not part of structural identity. They are profile-specific projection payload.

Small-pool items should benefit most. For a pickaxe-like pool such as:

```text
Efficiency
Unbreaking
Fortune / Silk Touch conflict group
```

paths that pick `Unbreaking` then the `Fortune/Silk Touch` choice, and paths that pick the same factors in the opposite order, should converge once the same abstract factors are present and the same continuation level has been reached.

## Order-Agnostic Pick History

The graph can only converge safely if selected history can also recognize equivalent picked-factor sets.

Current `FlexProgramStore` already has the useful pieces:

- choice alternatives are canonicalized and interned;
- with `canonicalizeProgramOrder: true`, equivalent program emission order can intern to the same `programId`.

The rank-merge model should generalize this, not invent a separate node-level history model.

Preferred long-term shape:

```ts
type PickFactorId = number & { readonly __brand: 'PickFactorId' };

interface PickFactor {
  readonly alternatives: readonly PickAlternative[];
}

interface PickAlternative {
  readonly enchantId: number;
  readonly weight: number;
}

interface ProgramHistoryKey {
  readonly profileSetId: number;
  readonly factors: readonly PickFactorId[]; // canonical sorted order
}
```

A solid picked enchant is a one-alternative factor. A conflict/Plex choice is a multi-alternative factor. A factor is keyed by abstract `enchantId`, not packed rank, so it can be shared by rank profiles.

Do not encode this as a concrete `PackedEnchant`. A packed enchant is a resolved leaf: `enchantId + rank`. A pick factor is a projection factor: one or more abstract enchant IDs plus weights.

Profile identity should sit beside the factor set:

```text
profileSet/profileMix + unordered picked factors
```

not inside every factor. The current prototype's `rank-fixed` and `rank-choice` put `profileId` inside the emission identity; that protects correctness, but prevents true convergence.

## Current Prototype Mismatch

The current rank-parametric prototype is useful, but it protects correctness by putting `profileId` into too many structural places:

- `GroupedFlexSearchRun` keys graphs by `pool.familySignature`, which is the right direction.
- `GroupedFlexGraph` registers rank profiles and emits `rank-fixed` / `rank-choice`, which is also useful.
- `GroupedFlexGraph.createNodeStateKey()` includes `profileId`, which prevents cross-profile node reuse.
- `GroupedFlexGraph.createGroupedExpansionShapeKey()` also includes `profileId`, which prevents shape reuse across rank-only variants.

That means the prototype mostly proves that the projector can rehydrate exact ranks from a profile lens. It does not yet prove the actual rank merge, because graph identity still treats profiles as separate structural state.

The opposite mistake would be removing `profileId` from graph identity while leaving only a single `profileId` on each program emission. That would merge mass whose exact-rank lens differs, but the surviving node would point at only one profile's history. Projection would then silently assign some mass to the wrong exact rank.

So the merge cannot be "drop `profileId` from nodes" by itself. The selected-history side must carry a profile set/mix or modified-level lens for the mass that reached the merged structural node.

There is also a current-code shape issue around `programId`. A node stores one `programId`, and reduced-mode frontier merging is keyed by graph/node identity. If a profile branch reuses a node first created by another profile branch, the reuse path must not keep only the first branch's selected history. Either the converged `programId` has to represent the canonical union history, or the frontier key must keep history/mix identity while sharing the structural expansion.

## Ownership Boundaries

Use this split as the rule when deciding where a detail goes:

| Concern | Owner |
|---|---|
| Eligible exact pool for one modified level | `RegistryKernel` / registry lookup |
| Rank-only pool-family signature | `RegistryKernel` |
| Structural future state | `GroupedFlexGraph` node identity |
| Weighted frontier mass | `FlexCoordinator` |
| Selected pick history | `FlexProgramStore` behind `programId` |
| Exact rank rehydration | `FlexProjector` |
| Probe counters and temporary flags | `GroupedFlexSearchRun` diagnostics |

The graph should not own selected exact ranks. The program store should not own future eligibility. The coordinator should not know how to resolve exact enchants.

## Merge Plan

### Phase 1: Keep The Lens, Remove The False Merge Claim

Keep the branch as a correctness prototype until the merge has a real profile-mix model.

Useful acceptance checks:

- `rankProfileMode: true` produces exact parity with default mode.
- Clue snapshots still match exact mode.
- Pending aggregate projection still conserves source mass across `projectedMass + clueIncompatible + projectionLoss`.

Do not present this phase as a performance merge. It is a payload/projection proof.

### Phase 2: Introduce Generic Pick Factors

Rename the current emission concept around what it means, not how it was discovered.

Preferred conceptual payload:

```ts
interface ProgramHistoryKey {
  readonly profileSetId: number;
  readonly factors: readonly PickFactorId[];
}

type PickFactorId = number & { readonly __brand: 'PickFactorId' };

interface PickFactor {
  readonly alternatives: readonly PickAlternative[];
}

interface PickAlternative {
  readonly enchantId: number;
  readonly weight: number;
}
```

For implementation, `profileSetId` can point to compressed profile IDs, but those profiles must map back to exact modified-level pools and projection must explain the mapping. The semantic model should stay modified-level-first because exact rank recovery is defined by the original pool lens.

The old names map as:

- `fixed` exact emission -> exact pick factor with one exact packed enchant, or compatibility path;
- `choice` exact emission -> same-pool conflict factor;
- `rank-fixed` -> pick factor with one enchant ID and a lens;
- `rank-choice` -> pick factor with multiple enchant IDs and one lens.

### Phase 3: Canonicalize Picked-Factor Sets

Make selected history order-agnostic for equivalent factor sets.

Example:

```text
[choice(Fortune/Silk Touch), fixed(Unbreaking)]
[fixed(Unbreaking), choice(Fortune/Silk Touch)]
```

These should intern to the same semantic history because both mean the same abstract picked-factor set. Projection can still apply book-removal slot semantics by treating each factor as one generated slot.

This phase should reuse the current `FlexProgramStore` interning pattern:

- intern each abstract pick factor;
- sort factor IDs in a canonical order;
- intern the resulting factor list;
- keep profile set/mix identity outside the factor itself.

### Phase 4: Add Profile Mix Before Cross-Profile Node Reuse

Before `profileId` can be removed from node identity, the program history must be able to represent merged rank lenses.

Conceptual shape:

```ts
interface RankLensMix {
  readonly profiles: readonly RankLensWeight[];
}

interface RankLensWeight {
  readonly profileId: number;
  readonly weight: bigint | number;
}
```

The mix is conditional composition at that program point, not global source probability. Absolute mass still belongs to the coordinator.

Projection uses the mix like this:

```text
for each profile in mix:
  packedEnchant = resolve(profileId, enchantId)
  add profile weight to that exact packed enchant
```

If multiple profiles resolve to the same packed enchant, combine them.

This is the missing bridge between "shared graph node" and "exact output rows".

### Phase 5: Enable Structural Node Reuse

Only after the factor-set and profile-mix representation is in place:

- key graphs by `pool.familySignature`;
- key shape cache by structural inputs, not profile ID;
- key node identity by exclusion mask, current level, count, and structural pool family, not profile ID;
- keep profile/lens information only in the selected-history payload.

This is the first phase that should be expected to reduce graph shape or node counts.

An incremental implementation may share graph expansion first while keeping `(nodeId, historyId/profileSetId)` on the frontier. That is easier to reason about than forcing one structural node to own one selected-history `programId` immediately.

### Phase 6: Add Diagnostics And Guardrails

Temporary diagnostics should answer:

- how much modified-level mass was eligible for rank merge;
- how much actually used a merged structural path;
- how much fell back to exact pool handling;
- whether any fallback came from non-rank structural differences;
- whether projection produced the same exact snapshots as the non-merged path.

The `origin/codex/rank-mux-probes` branch has useful probe counters and fallback framing, but its current implementation should be treated as scaffolding, not a target architecture.

## What To Salvage

From this branch:

- `RegistryKernel.familySignature`;
- profile registration and exact lookup by `(profileId, enchantId)`;
- projector support for resolving rank-parametric factors;
- current `FlexProgramStore` canonicalization and interning patterns;
- tests that assert exact clue matching does not degrade into `rank >= target`.

From `origin/codex/rank-mux-probes`:

- internal opt-in controls for experimental merge behavior;
- diagnostics for eligible/used/fallback rank-merge mass;
- the idea that conflict merge and rank merge are independent flags;
- the warning that rank choices are correlated by profile and must not be projected as independent exact alternatives unless the correlation has been explicitly represented.

Avoid carrying forward:

- rank-specific names as the long-term public model;
- node subclasses or node kinds for every merge combination;
- storing whole pools on nodes;
- storing `profileId` inside each picked factor;
- putting profile identity in structural keys once the profile-mix payload exists.

## Open Questions

1. Is `modifiedLevel` the durable semantic key in program factors, with `profileId` only an internal compression, or should the implementation expose only profile IDs internally?
2. Where should profile mixes be interned: `FlexProgramStore`, `GroupedFlexSearchRun`, or a small side table owned by the projector?
3. Should the first implementation share structural expansions while keeping `(nodeId, historyId/profileSetId)` on the frontier?
4. Can the first real merge be restricted to singleton structural choices, leaving conflict-choice rank mixes for a later phase?
5. What exact parity suite should gate the first merge: full snapshots, clue snapshots, pending aggregates, or all of them?

## Implementation Direction

The preferred follow-up is to keep the architectural slot that V8 currently calls an emission, but change the payload and naming:

- keep structural graph nodes independent from exact ranked enchants;
- replace exact packed fixed/choice emissions with interned generic pick factors;
- keep picked factors order-agnostic when they describe the same selected set;
- attach `profileSetId` / `profileMixId` beside the factor set, not inside the factor;
- keep graph nodes structural and pool-free;
- let the projector resolve exact ranked enchants from the modified-level lens.

The rank-specific `rank-fixed` and `rank-choice` variants from the prototype are best treated as scaffolding for comparison, not the long-term shape.

## References / Related Docs

- [`search-engine.md`](search-engine.md)
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Prototype branch: `prototype/rank-parametric-pool-factors`

## Owner / Maintainer

Jonathan Braver

## Last Updated

2026-05-31
