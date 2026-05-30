# Rank Pool Merge Temporary Design Note

Status: experimental implementation note
Created: 2026-05-29
Updated: 2026-05-30
Intended destination: fold proven parts into `docs/search-engine.md`

## Summary

Rank pool merge is an internal Flex optimization for modified-level pools that
have the same structural enchant set but differ only by exact ranks.

The current implementation models Rank as pool-profile metadata:

- Programs record structural enchant picks: `Sharpness`, not `Sharpness IV`.
- A node carries `poolProfileId`.
- Exact behavior is represented by a single-source pool profile.
- RankMerge is represented by a multi-source pool profile.
- Result identity is `(programId, poolProfileId)`.
- `Conflict` and `Rank` are sticky diagnostic flags, not node subclasses.
- V1 is converged-only: sources may merge only once future continuation uses one
  shared scalar `currentLevel`.

This replaced the earlier experimental idea of special `rank` or `rankChoice`
program emissions.

## API Boundary

Rank pool merge is internal engine behavior. Public results, snapshots, summary
rows, and mass accounting should stay exact and unchanged by whether a run used
Solid, Conflict, Rank, or combined Conflict+Rank internal factoring.

Temporary internal controls are still useful for probes and parity tests:

```ts
interface FlexOptimizationControls {
    readonly allowConflictMerge?: boolean;
    readonly allowRankMerge?: boolean;
}
```

Do not add an XOR mode for "either Conflict or Rank but not both" in v1. That
policy is order-dependent and would need a real optimizer over merge choices.
Run separate probes with the two booleans instead.

## Core Model

`FlexProgramStore` stores structural emissions:

```text
fixed  -> one enchantId
choice -> weighted enchantId alternatives from a Conflict-compatible group
```

`FlexPoolProfileStore` maps structural `enchantId` values to exact packed
enchants:

```text
single-source profile -> exact pool behavior
multi-source profile  -> RankMerge profile over compatible exact pools
```

Each profile source stores:

```text
exact pool key
level count
source mass
relative profile weight
enchantId -> exact packed enchant lens
```

The multi-source profile preserves source correlation. Projection chooses one
profile source for the whole projected row, then maps every selected
`enchantId` through that same source lens. This prevents impossible mixed-source
combos such as `Sharpness III` from one modified level and `Unbreaking III`
from another when those slots should be correlated.

## Node Identity

Nodes include `poolProfileId`, and graph identity includes profile identity
where exact materialization could differ.

```ts
interface FlexNode {
    readonly id: FlexNodeId;
    readonly programId: FlexProgramId;
    readonly poolProfileId: FlexPoolProfileId;
    readonly count: number;
    readonly mergeFlags: FlexMergeFlags;
}
```

Resolved result mass is keyed through an interned result key:

```text
FlexResultId -> (programId, poolProfileId)
```

This is required because the same structural program can project to different
exact ranks under different profiles.

## Merge Flags

Flags describe which equivalence classes have been used on the path:

```ts
const enum FlexMergeFlag {
    Conflict = 1 << 0,
    Rank = 1 << 1
}
```

`Conflict` is set by choice emissions. `Rank` is set by multi-source pool
profiles. The legacy `solid` / `plex` node kind remains a diagnostic view:
nodes with Conflict are reported as `plex`; Rank alone remains Solid-like.

Combined Conflict+Rank paths are legal: a choice picks an enchant ID and the
active profile resolves that ID to an exact rank.

## Eligibility

RankMerge is valid only for rank-only pool variants.

Required invariants:

- Sources share one `SearchPoolFamilySignature`.
- Structural entries align by `enchantId`, table weight, conflicts, and blocking
  behavior.
- The merged child uses the same future `currentLevel`.
- Exact ranks differ only through the profile lens.
- If one static converged profile cannot represent the merged state, the search
  falls back to exact single-source profiles.

Non-goals:

- Do not merge pools with different enchant groups.
- Do not merge pools with different weights or conflicts.
- Do not model nested pools.
- Do not represent rank variants as independent Conflict choices.
- Do not carry per-source continuation lanes in v1.

## Projection Semantics

Projection is profile-first:

1. Decode `FlexResultId` into `(programId, poolProfileId)`.
2. Pick one profile source by its profile weight.
3. Walk the structural program.
4. Resolve every fixed or choice `enchantId` through that same source lens.
5. Apply exact clue filtering, pending aggregates, and book removal to the
   resolved packed enchants.

This same path is used for resolved rows, pending aggregates, clue-conditioned
pending splits, joint clue aggregates, and book-removal projections.

## Statistics

Current stats report:

```text
rankMerge.eligibleFamilyGroupCount
rankMerge.eligibleExactPoolCount
rankMerge.eligibleLevelCount
rankMerge.eligibleMass
rankMerge.usedFamilyGroupCount
rankMerge.usedExactPoolCount
rankMerge.usedLevelCount
rankMerge.usedMass
rankMerge.fallbackFamilyGroupCount
rankMerge.fallbackExactPoolCount
rankMerge.fallbackLevelCount
rankMerge.fallbackMass

rankProfiles.profileCount
rankProfiles.sourceExactPoolCount
rankProfiles.sourceLevelCount
rankProfiles.sourceMass
rankProfiles.profileWeight
rankProfiles.rankVariantEnchantCount
rankProfiles.rankAlternativeCount
rankProfiles.maxExactPoolCount
rankProfiles.maxLevelCount
rankProfiles.maxRankVariantEnchantCount
rankProfiles.maxRankAlternativeCount
```

`rankProfiles` currently includes both exact single-source profiles and
multi-source Rank profiles because both are the same store.

Useful future diagnostics:

```text
nodesWithRankFlag
nodesWithConflictRankFlags
expandedNodesWithRankFlag
projectionProfileSourceVisits
rankUnsafeProfileFallbackCount
rankExactClueFallbackCount
```

## Probe Snapshot

The reusable investigation script is:

```text
npm run benchmark:rank-shape -- --mode all
```

It measures row collapse for the actual XP root distribution and aligned
power-of-two blocks. Representative modern XP 30 findings from the shape probe:

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

Useful commands:

```text
npm run benchmark:rank-shape -- --mode rows
npm run benchmark:rank-shape -- --mode blocks
npm run benchmark:rank-shape -- --mode weighted-blocks
npm run benchmark:rank-shape -- --all-materials --mode summary
npm run benchmark:rank-shape -- --item pickaxe --material diamond --mode all
```

## Next Questions

- Should profile stats split exact single-source profiles from multi-source Rank
  profiles?
- Which node/expansion counters are most useful for Conflict+Rank diagnosis?
- How much modern-book savings remains after converged-only Rank is measured
  against exact baselines?
- Can exact clue searches safely enable Rank with profile-first clue splitting,
  or should they continue to fall back until broader parity coverage exists?
- Is source-lane continuation worth implementing, or does converged-only capture
  enough of the tree-shape win?
