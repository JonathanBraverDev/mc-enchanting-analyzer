# Rank Pool Merge Temporary Design Note

Status: experimental design note
Created: 2026-05-29
Intended destination: fold proven parts into `docs/search-engine.md`

## Purpose

Rank pool merge is a proposed optimization for rank-only modified-level pool
variants.

The goal is to let structurally identical pools share tree shape even when the
exact rank payload differs by modified level. Example:

```text
Level 14 pool: Sharpness III, Bane IV, Smite IV, ...
Level 15 pool: Sharpness IV, Bane IV, Smite IV, ...
```

The future search behavior is the same for `Sharpness` in both pools:

- Same enchant ID.
- Same table weight.
- Same self/conflict exclusion mask.
- Same future eligibility after selection.

Only the exact payload rank differs. The optimization should preserve exact
result and clue semantics while letting the shared structural future be
represented once.

This note is temporary. It should stay separate from the maintained engine
deep dive until the optimization is proven correct and useful.

## API Boundary

Rank pool merge should be internal engine behavior. Public result semantics
should not depend on whether a search used fixed emissions, Conflict merges,
Rank merges, or any future combination of factorized emissions.

The supported API should continue to expose exact results, snapshots, summaries,
and accounting buckets. It should not expose merge flags as product-level
concepts unless there is a deliberate future diagnostics API.

Temporary controls are still useful while proving the optimization. They should
live on internal search/run options, benchmark scripts, probes, and diagnostic
tests rather than the public `EnchantingAnalyzer` surface.

## Current Model

The current grouped runtime has two semantic emission shapes:

```text
fixed  - one exact packed enchant
choice - one same-pool weighted Conflict group whose alternatives share future behavior
```

Current node classification is effectively sticky:

```text
program has no Conflict emissions -> SolidNode
program has any Conflict emission -> PlexNode
```

That works because `FlexProgramStore` stores parent-linked program history. Once
a Conflict emission appears in a program, all descendants inherit that history
and are classified as Plex.

Rank should follow the same inheritance model, but as an independent merge flag:

```text
program has any Rank emission -> Rank flag is set
all descendants inherit Rank
```

The key model change is to stop treating node type as a single exclusive enum.
It is more naturally a set of program-derived flags.

## Proposed Flags

Use a small bitmask named for the equivalence class that made a merge legal:

```ts
const enum FlexMergeFlag {
    Conflict = 1 << 0, // same-pool child-exclusion group
    Rank = 1 << 1      // same structural pool family, different exact ranks
}

type FlexMergeFlags = number;
```

No flag means the plain fixed/Solid case: one exact packed enchant and no merge
behavior in program history.

`Conflict` is the current Plex behavior. Plex can remain a diagnostic/display
label, but the internal flag name should say what was merged.

Avoid building a generalized node-type matrix. If a probe needs to count nodes
with both bits set, add that as a direct diagnostic counter, not as a new
semantic node category.

The physical graph node does not need a new subclass for v1. The node can keep
the same structural fields:

```text
id
programId
count
currentLevel
exclusionMask
mergeFlags
```

The behavior lives in the program emission stream and in projection. The graph
and coordinator mostly need to know the flags for diagnostics and for any
identity rules that prevent unsafe merging.

## Why Conflict And Rank Are Separate

Conflict represents a same-pool table choice:

```text
one pool denominator
multiple exact alternatives
same child exclusion state
```

Rank represents a rank payload lens over multiple rank profiles:

```text
one structural enchant
same future behavior
exact rank depends on the source rank profile
```

Those are close, but not identical. Conflict alternatives are ordinary weighted
enchant alternatives from one pool. Rank alternatives are correlated by profile.
If two slots are both rank-merged from the same profile set, their exact ranks must not
be projected as independent choices unless the profile correlation has been
explicitly discarded by a safe invariant.

This means Rank may reuse some choice projection machinery, but it should be a
distinct semantic emission and merge flag.

## Core Concepts

### Structural Enchant

A rank-abstract entry keyed by behavior:

```text
enchantId
weight
idBit
conflictBitset
blocksBitset
```

This is the part that controls graph shape.

### Rank Lens

A rank lens maps a structural enchant and rank profile to an exact packed
enchant:

```text
rankLens(profileA, sharpness) -> Sharpness III
rankLens(profileB, sharpness) -> Sharpness IV
```

A profile is a rank-payload profile, usually represented by an exact
`SearchPoolSignature` inside one `SearchPoolFamilySignature`. Multiple modified
levels with the same exact pool can share one rank profile.

### Profile Mix

A profile mix is a normalized vector over rank profiles for a particular merged
program state.

It must not be absolute source mass. Absolute mass belongs to the coordinator
and changes with frontier flow, residue recovery, clue pruning, probability
floors, and checkpoint timing.

The mix must represent conditional composition of the mass at the point where
projection is allowed to see a rank-merged slot:

```text
profileA: 37
profileB: 63
```

Those numbers are relative weights, not public probability units.

### Rank Emission

Conceptual shape:

```ts
interface FlexRankEmission {
    readonly kind: 'rank';
    readonly enchantId: number;
    readonly profileMixId: FlexProfileMixId;
    readonly rankLensId: FlexRankLensId;
}
```

Projection turns it into exact ranks by applying the mix through the lens:

```text
for each profile in profileMix:
  packedEnchant = rankLens(profile, enchantId)
  add profile weight to packedEnchant alternative
```

If multiple profiles map to the same exact packed enchant, projection can combine
their weights.

## Eligibility

Rank is only valid for rank-only pool variants.

Required invariants:

- All merged pools share one `SearchPoolFamilySignature`.
- Their structural entries align by `enchantId`, `weight`, `conflictBitset`, and
  `blocksBitset`.
- Node identity still agrees on future state: same `currentLevel`, same `count`,
  same `exclusionMask`, and same structural graph.
- Rank differences are represented only through the rank lens.
- The runtime either proves the same profile mix for all merged mass at a node,
  or keeps incompatible mixes separate.

Non-goals for this optimization:

- Do not merge pools with different enchant groups.
- Do not merge pools with different table weights or conflicts.
- Do not model nested pools.
- Do not represent profile-specific ranks as independent Conflict choices.

## Solid-Only First Slice

The first implementation can support Rank only where the current grouped
graph would emit a fixed singleton emission.

That gives three practical behaviors:

```text
fixed emission       -> current Solid behavior
Conflict emission    -> current Plex behavior
Rank emission        -> Solid-like structural edge with profile-aware rank payload
```

In v1, grouped Conflict edges can remain exact/fallback-only:

```text
if edge is singleton and rank-only profiles differ:
  emit Rank
else if edge is Conflict-compatible in the current exact-pool sense:
  emit Conflict
else:
  fall back to exact graph behavior
```

This keeps the first slice small. It also leaves a clear path for a future
implementation where `Conflict` and `Rank` can both be true, without
creating a named compound node type.

Expected tradeoff: Solid-only Rank may capture less upside in book-heavy cases,
because many useful groups are Conflict groups. The probe suite should report
singleton-eligible and Conflict-eligible savings separately before deciding
whether to extend Rank into grouped alternatives.

## Identity And Merge Safety

The current reduced identity mode intentionally ignores program ID for structural
node reuse. That is safe only when all programs reaching a reduced node are
projection-equivalent.

Rank changes that rule. Two structural paths with different profile mixes are
not projection-equivalent.

Possible implementation strategies:

1. Conservative identity:
   include a rank projection key in reduced identity whenever the program has
   Rank. This keeps incompatible mixes separate while still allowing graph
   construction to share rank-abstract pool shape.

2. Profile-aware frontier aggregate:
   keep one structural node but let the coordinator carry a compact profile
   vector, or several profile-mix lanes, for pending mass at that node.

3. Proven static mix:
   only merge paths when the profile mix is known to be identical for every
   arrival, and intern that mix as part of the Rank emission.

The first prototype should prefer correctness and instrumentation over maximum
sharing. If the runtime cannot prove profile-mix equivalence, it should fall
back to exact pool behavior or keep distinct profile-mix identities.

## Projection Semantics

`FlexProjector` needs explicit Rank handling in every place it currently handles
fixed and Conflict emissions:

- Resolved result projection.
- Pending aggregate projection.
- Shown clue distribution.
- Clue-conditioned pending split.
- Joint clue aggregates.
- Book removal slot handling.

For result rows, a Rank emission behaves like one generated slot. It expands
to exact packed enchant alternatives according to the profile mix and rank lens.

For clue handling, an exact target clue can match only the profiles whose lens
maps the structural enchant to that exact packed enchant. Non-matching profiles
must remain reachable or incompatible according to the same rules used for
fixed/Conflict emissions, but with the profile split preserved.

## Statistics

Rank needs heavy instrumentation from the start.

Eligibility and use:

```text
rankMergeEligibleFamilyGroupCount
rankMergeEligibleExactPoolCount
rankMergeEligibleLevelCount
rankMergeEligibleMass
rankMergeUsedFamilyGroupCount
rankMergeUsedExactPoolCount
rankMergeUsedLevelCount
rankMergeUsedMass
rankMergeFallbackCount
rankMergeFallbackMass
```

Graph shape:

```text
rankMergeFamilyGraphMergeCount
rankMergeFamilyGraphSavedCount
rankMergeGraphNodeSavedEstimate
rankMergeSingletonEligibleEdgeCount
rankMergeConflictEligibleEdgeCount
rankMergeSingletonUsedEdgeCount
rankMergeConflictDeferredEdgeCount
```

Program and node classification:

```text
conflictEmissionCount
rankEmissionCount
rankAlternativeCount
rankProfileMixCount
rankLensCount
nodesWithRankMergeCount
expandedNodesWithRankMergeCount
```

Projection:

```text
rankProjectionSplitCount
rankProjectionAlternativeVisitCount
rankProjectionLoss
rankPendingAggregateSplitCount
rankClueSplitCount
rankBookRemovalSplitCount
```

Correctness guardrails:

```text
rankUnsafeMixFallbackCount
rankExactClueFallbackCount
rankProgramIdentityFallbackCount
rankInvariantFailureCount
```

## TODO: Internal Optimization Booleans

Add only direct internal booleans for experiments and parity checks.

For now, the useful controls are:

```ts
interface FlexOptimizationControls {
    readonly allowConflictMerge?: boolean;  // current Plex behavior
    readonly allowRankMerge?: boolean;
}
```

Do not add a generic merge-policy matrix. If more factorization options appear,
add one deliberate boolean per proven optimization and keep the search behavior
easy to reason about.

This should be wired only through internal runtime/probe paths at first:

- `GroupedFlexSearchRunOptions`
- `GroupedFlexGraphOptions`
- benchmark/probe scripts
- diagnostic tests

Avoid promoting these controls to the public API until the behavior is stable
and there is a real external need.

Do not implement an `allowEitherButNotBoth` / XOR mode in v1.

That mode sounds useful for experiments, but it is likely order-dependent and hard
to define consistently. A path that first becomes Conflict might block a later
Rank opportunity, while the opposite construction order might make the other
choice look better. Resolving that properly would require a policy optimizer over
factorization choices, which is not worth building for this experiment.

If a comparison is needed, run separate probes by setting the two booleans
directly.

## Probe Snapshot

The exploratory `tmp/pool-superposition-probe.ts` hack reused family graphs with
representative exact ranks. It is not result-correct, but it estimates structural
upside for rank-family sharing.

Modern book XP 30:

```text
1.21.11 book/book XP30
exact graphs: 8
family graphs: 3
graph nodes: 337550 -> 157870
node reduction: 53.2%
search time in probe: 1371ms -> 552ms
```

Legacy book XP 30:

```text
1.7.2 book/book XP30
exact graphs: 8
family graphs: 3
graph nodes: 26871 -> 10471
node reduction: 61.0%
search time in probe: 104ms -> 34ms
```

The same probe showed small absolute benefits for non-book cases. That suggests
Rank should be optimized and validated primarily against modern book-heavy
searches, with non-book cases treated as regression guards.

## Rank Shape Probe

The reusable investigation script is:

```text
npm run benchmark:rank-shape -- --mode all
```

It measures two related questions:

1. Row collapse for the actual XP root distribution.
   Each depth compares unique rows under:
   `childLevel`, `(childLevel, exact pool)`, and `(childLevel, family pool)`.
2. Aligned power-of-two blocks.
   Each block checks whether every modified level in that block shares one
   exact or rankless family signature.

The row-collapse table is the closest proxy for the expected tree shape. If
the family sequence equals the ideal child sequence, rank-only family merging
has removed every rank-split row that remains after level division.

Representative modern XP 30 findings:

```text
pickaxe/diamond
ideal:   15 -> 8 -> 5 -> 3 -> 2 -> 2
exact:   15 -> 10 -> 7 -> 5 -> 4 -> 4
family:  15 -> 8 -> 5 -> 3 -> 2 -> 2

sword/diamond
ideal:   15 -> 8 -> 5 -> 3 -> 2 -> 2
exact:   15 -> 12 -> 11 -> 9 -> 8 -> 8
family:  15 -> 9 -> 6 -> 4 -> 3 -> 3

book/book
ideal:   11 -> 6 -> 4 -> 2 -> 2 -> 2
exact:   11 -> 9 -> 9 -> 8 -> 8 -> 8
family:  11 -> 6 -> 5 -> 4 -> 4 -> 4
```

The strong result is that many item families hit the ideal halving shape:
diamond pickaxe, axe, shovel, hoe, bow, fishing rod, trident, crossbow, mace,
and diamond spear all matched the ideal child rows in the first probe run.

The weaker result is that books and armor still benefit but do not become a
clean power-of-two collapse. They need either more precise profiling or a later
Rank-in-Conflict implementation before assuming large savings there.

Useful commands:

```text
npm run benchmark:rank-shape -- --mode rows
npm run benchmark:rank-shape -- --mode blocks
npm run benchmark:rank-shape -- --mode weighted-blocks
npm run benchmark:rank-shape -- --all-materials --mode summary
npm run benchmark:rank-shape -- --item pickaxe --material diamond --mode all
```

## Suggested Implementation Order

1. Add program merge flags:
   `FlexMergeFlag.Conflict` and `FlexMergeFlag.Rank`.

2. Add Rank emission types and interners without enabling graph merging.
   Projection tests should prove fixed, Conflict, and Rank emissions compose
   correctly.

3. Add registry family-profile construction:
   rank lenses, profile ids, and profile mix interning.

4. Add shadow stats:
   report eligible rank-only family groups and estimated savings with no behavior
   change.

5. Enable Solid-only Rank behind an internal option.
   Fall back aggressively for exact clue searches and unsafe mix cases.

6. Compare:
   exact snapshots, mass accounting buckets, projection loss, pending aggregates,
   and wall-clock time.

7. Decide whether Rank should also be supported inside grouped Conflict edges.
   This should depend on measured missed savings from Conflict-eligible deferred
   edges, without introducing a named compound node type.

## Open Questions

- Should profile mix live in program identity, coordinator pending state, or both?
- Can we prove a stable profile mix for common convergence points like
  `14 -> 7` and `15 -> 7`, or should v1 keep mixes separate?
- Should exact clue searches initially disable Rank, or can clue splitting be
  implemented safely in the first pass?
- How much modern-book savings remains when v1 supports only singleton
  structural edges?
- What is the cheapest reduced-identity key that prevents unsafe Rank program
  merging without losing most graph sharing?
