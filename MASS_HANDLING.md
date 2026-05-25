# Mass Handling & Honest Accounting - Minecraft Enchantment Analyzer

## Common Description

This document is the current probability-accounting reference for the V8 search engine. It explains how the engine preserves every fixed-point unit of probability mass while searching a globally weighted frontier across modified levels.

## Table of Contents

- [Purpose / Scope](#purpose--scope)
- [Honest Accounting Principle](#honest-accounting-principle)
- [Active Mass Buckets](#active-mass-buckets)
- [Diagnostic Recovery Buckets](#diagnostic-recovery-buckets)
- [Fixed-Point Probability Units](#fixed-point-probability-units)
- [V8 Weighted Search Accounting](#v8-weighted-search-accounting)
- [Remainder and Residue Handling](#remainder-and-residue-handling)
- [Book Redistribution](#book-redistribution)
- [Clue-Conditioned Searches](#clue-conditioned-searches)
- [Reporting vs Accounting](#reporting-vs-accounting)
- [Optimization Guardrails](#optimization-guardrails)
- [Troubleshooting](#troubleshooting)
- [References / Related Docs](#references--related-docs)
- [Owner / Maintainer](#owner--maintainer)
- [Last Updated](#last-updated)

## Purpose / Scope

This document covers engine-internal probability conservation for V8. It does not describe every Minecraft rule, UI projection, or chart rendering path.

Use this file when changing:

- `FlexCoordinator` mass movement,
- `GroupedFlexGraph` expansion semantics,
- residue/remainder handling,
- clue pruning,
- book redistribution,
- summary or snapshot interpretation of pending mass.

For broader architecture and search identity details, see `ARCHITECTURE.md` and `docs/v8-search-engine.md`.

## Honest Accounting Principle

Every probability unit introduced into a search must remain accounted for until the checkpoint snapshot is reported. Mass may move between buckets, but it must not disappear.

The active invariant is:

```text
resolved
+ clueIncompatible
+ pending
+ sieved
+ overflow
+ capped
+ rounding
== PRECISION
```

`PRECISION` is `2^60` fixed-point units.

Recovered diagnostic buckets are not part of this sum. They explain how much mass became assignable after carried residue combined with later arrivals, but they do not add new active mass.

## Active Mass Buckets

| Bucket | Meaning | User-facing interpretation |
| --- | --- | --- |
| `resolved` | Search reached a terminal result program and assigned mass to exact output combinations. | Known result mass / accuracy for unconditioned searches. |
| `clueIncompatible` | Search or projection proved mass cannot contribute to the displayed clue-conditioned result set. | Classified non-result mass for clue searches. |
| `pending` | Mass remains in the global frontier at the checkpoint. | Uncertainty / improvable mass. |
| `sieved` | Mass was intentionally discarded by a probability floor. | Pruned mass. |
| `overflow` | A path exceeded supported engine limits such as max enchant count. | Limit loss. |
| `capped` | A safety/resource cap stopped further materialization. | Limit loss. |
| `rounding` | Fixed-point division residue or projection loss that is still active but not assignable to an exact branch yet. | Rounding uncertainty. |

For unconditioned searches, reported accuracy usually means `resolved`. For clue-conditioned searches, reported accuracy is classified mass: `resolved + clueIncompatible`, because both buckets are no longer frontier uncertainty.

## Diagnostic Recovery Buckets

| Bucket | Meaning |
| --- | --- |
| `recoveredRounding` | Gross mass that became assignable because carried split residue combined with later mass at the same expansion. |
| `recoveredSieved` | Historical/diagnostic concept for mass saved from pruning; not part of active conservation. |

Diagnostic recovery buckets are non-additive. They answer "how much did the residue mechanism help?" rather than "where is the current probability mass?"

## Fixed-Point Probability Units

V8 uses `bigint` probability units scaled to `PRECISION = 2^60`.

Rules:

- Convert external numeric probabilities to fixed-point units at boundaries.
- Use integer arithmetic for internal mass movement.
- Convert back to `number` only for presentation or diagnostics.
- Treat integer division remainders as first-class mass, not disposable error.

This avoids floating-point drift and keeps conservation tests exact.

## V8 Weighted Search Accounting

V8 seeds a single coordinator with the modified-level distribution for one XP cell:

```text
XP + enchantability -> modified level distribution
modified level L with probability P(L) -> root mass P(L)
```

The coordinator stores all pending work in one globally weighted frontier. Each frontier entry points to a structural node and carries weighted mass. The next expansion is chosen by weighted pending mass, not by a per-modified-level local budget.

This differs from the older naive model:

```text
old model: search each modified level separately, then scale results by P(L)
V8 model: scale at root, merge equivalent future mass during search
```

The V8 model gives a more meaningful checkpoint frontier: the largest pending entries are globally largest contributors to remaining uncertainty.

## Remainder and Residue Handling

Weighted fanout uses integer division:

```text
childMass = floor((incomingMass * edgeWeight + oldEdgeResidue) / totalWeight)
newEdgeResidue = (incomingMass * edgeWeight + oldEdgeResidue) % totalWeight
```

The engine carries residue per outgoing edge on the exact source expansion. If later mass reaches the same source expansion, the old residue participates in the next split and may promote units back into child mass.

Guardrails:

- Do not eagerly assign leftover units to arbitrary child edges.
- Do not use largest-remainder allocation unless the equivalence basis is proven.
- Do not pool residue across different source expansions just because the visible combo matches.
- Pooling is valid only after mass reaches the same full equivalence point.

This may leave tiny active `rounding` mass, but it preserves exact accounting without inventing probability.

## Book Redistribution

Modern enchanted books can generate multiple enchantments and then remove one selected enchantment. V8 handles this after a generated result program resolves:

1. Search resolves the generated multi-enchant book program.
2. Projection enumerates the possible post-removal combos.
3. Mass is divided across those post-removal combos.
4. Any local redistribution remainder is carried as projection loss or book redistribution residue, depending on the materialization path.

Book redistribution is allowed to assign within that local resolved context because the original generated program has already fully resolved. This is different from edge-split residue, where future branches may still have incompatible structure.

## Clue-Conditioned Searches

Displayed table clues are handled by search-time pruning plus reporting-time Bayesian projection.

`ClueSearchPolicy` can prune a branch when the target clue has not already been selected and the candidate:

- is the same enchantment at the wrong rank,
- conflicts with the target clue enchantment,
- or cannot lead to the target clue.

Pruned mass goes to `clueIncompatible`. Resolved or projected mass that settles without the displayed clue also becomes `clueIncompatible`.

`clue.knownSpace` is not an accounting bucket. It is a reporting value derived later from the displayed clue mass, so it must not be added into the active conservation invariant.

## Reporting vs Accounting

Accounting tracks where probability mass lives. Reporting derives user-facing summaries from the current snapshot.

Important separations:

- `summaryLimit` and `comboLimit` control export size, not search work.
- Target combo filters are projections over the snapshot, not separate search modes.
- Chart cells and top results consume the same snapshot semantics.
- Pending frontier entries are meaningful data, but V8 can summarize factorized pending state without exposing every internal node/program detail to product callers.
- Projection-stage loss must fold back into public `rounding` exactly.

## Optimization Guardrails

Optimizations are welcome only when they preserve the active invariant and the semantic identity of future state.

Current safe/default optimizations:

- `SearchPoolSignature` structural graph reuse for exact pool-equivalent modified levels.
- Grouped same-future choices represented as `PlexNode`s.
- Compact `FlexProgramStore` history for fixed and choice emissions.
- XP-cell run caching for refinement resume.
- Native snapshot construction from coordinator state.
- Lazy pending aggregate projection reuse.

Never merge by visible combo alone. Visible output can match while future eligible pools or program history differ.

## Troubleshooting

- If conservation fails, inspect the active bucket sum first. Do not include recovered diagnostic buckets in the invariant.
- If clue-conditioned accuracy looks too high, verify whether `clueIncompatible` is being correctly counted as classified mass rather than result mass.
- If a performance optimization reduces iterations but slows runtime, profile the per-pending/per-program overhead.
- If book results show unexpected tiny tail differences, inspect book redistribution residue, active `rounding`, and projection loss before assuming mass loss.

## References / Related Docs

- `ARCHITECTURE.md` - engine and worker flow map.
- `docs/v8-search-engine.md` - V8 search behavior, factorized-tree design, and invariants.
- `src/lib/search/flex/` - internal coordinator, graph, projection, and snapshot implementation.

## Owner / Maintainer

Jonathan Braver / V8 search engine maintainers.

## Last Updated

2026-05-24
