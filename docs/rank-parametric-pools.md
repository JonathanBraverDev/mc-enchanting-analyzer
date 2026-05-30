# Rank-Parametric Pool Design Note

## Common Description

This note records the design conclusion from the rank-parametric pool prototype branch. It explains why the original idea clashes with the V8 grouped-search implementation, and how the refined modified-level lens model can fit the current architecture with less ownership churn.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Current V8 Ownership](#current-v8-ownership)
- [Original Idea Conflict](#original-idea-conflict)
- [Refined Model](#refined-model)
- [Exact Enchant Resolution](#exact-enchant-resolution)
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

The intended program-history record is a generic pick factor:

```ts
interface PickFactor {
  readonly modifiedLevel: number;
  readonly alternatives: readonly PickAlternative[];
}

interface PickAlternative {
  readonly enchantId: number;
  readonly weight: number;
}
```

A solid transition is a factor with one alternative. A Plex transition is a factor with multiple alternatives. The model does not need separate rank-specific emission variants.

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
- projection pays a cached lookup by `(modifiedLevel, enchantId)`;
- exact result rows remain recoverable without storing full pools on nodes.

If multiple modified levels share identical eligible buckets, caching can later use a pool or bucket signature. The semantic key should remain modified level unless and until equivalence is proven.

## Implementation Direction

The preferred follow-up is to keep the architectural slot that V8 currently calls an emission, but change the payload and naming:

- keep `programId` as the node's selected-history pointer;
- replace exact packed fixed/choice emissions with generic pick factors;
- include `modifiedLevel` on the factor or equivalent program lane metadata;
- keep graph nodes structural and pool-free;
- let the projector resolve exact ranked enchants from the modified-level lens.

The rank-specific `rank-fixed` and `rank-choice` variants from the prototype are best treated as scaffolding for comparison, not the long-term shape.

## References / Related Docs

- [`search-engine.md`](search-engine.md)
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Prototype branch: `codex/rank-parametric-pools`

## Owner / Maintainer

Jonathan Braver

## Last Updated

2026-05-30
