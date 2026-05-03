# Mass Handling & Honest Accounting — Minecraft Enchantment Analyzer

This document details the mathematical framework used by the Enchantment Engine to ensure 100% probability mass conservation and high-precision reporting.

## The "Honest Accounting" Principle

In most enchantment calculators, probability mass is "lost" due to early pruning or floating-point drift. This engine follows the principle of **Honest Accounting**: every single unit of probability mass introduced at the start of a search must be accounted for in one of six terminal buckets. No mass is ever deleted; it is only re-categorized.

---

## The Six Buckets of Mass

Every outcome of the enchantment simulation terminates in exactly one of these categories:

| Bucket | Purpose | UI Designation |
|:---|:---|:---|
| **Resolved** | Successful leaf node. The exact combination reached via game rules. | **Accuracy** |
| **Pending** | Nodes remaining in the Priority Queue, unexplored due to threshold or iteration limits. | **Uncertainty** |
| **Sieved** | Nodes intentionally discarded because their probability fell below the `SYSTEM_THRESHOLD_FLOOR` (1e-10). | **Pruned** |
| **Overflow** | Outcomes that are mathematically possible but exceed the engine's technical limit (6 enchantments). | **Limit Loss** |
| **Capped** | Outcomes lost because a resource limit was hit (e.g., `resultsLimit` or `MAX_QUEUE_SIZE`). | **Limit Loss** |
| **Rounding** | Cumulative compensation for integer division remainders and fixed-point conversion. | **Rounding** |

**Invariant**: `Resolved + Pending + Sieved + Overflow + Capped + Rounding === 1.0` (precisely $2^{60}$).

---

## Diagnostic Recovery Buckets (The Harvester's Impact)

These buckets are **non-additive**. They do not contribute to the 1.0 total mass. Instead, they track how much mass was "saved" by the Harvester logic:

| Bucket | Purpose |
|:---|:---|
| **Recovered Rounding** | Mass that would have been lost to the `Rounding` bucket but was "promoted" back to probabilities by the residual accumulator. |
| **Recovered Sieved** | Mass that was intended for the `Sieved` bucket (below individual threshold) but was successfully resolved because it was combined with other path mass. |

---

## Core Mathematical Infrastructure

### 1. High-Precision Fixed-Point (BigInt)
To avoid the binary-decimal drift of IEEE 754 floats, the engine uses `BigUint64Array` and `bigint` for all internal mass storage.
- **Scale**: $2^{60}$ (`PRECISION`). This provides roughly 18 decimal places of accuracy, far exceeding typical double-precision requirements.
- **Conversion**: Probabilities are converted to BigInt as early as possible (in `ProbUtils.toBigInt`) and returned to `number` only for final UI display.
- **Scope**: BigInt is required for probability mass. Search graph identity uses the `number53` path for current vanilla registries, with a `bigint64` path for registries whose enchant IDs no longer fit the safe-number key range.

### 2. Banker's Rounding (Statistically Neutral)
The engine implements **Banker's Rounding** (Round-to-Nearest-Even) for scaling operations.
- **The Why**: Standard "round half up" introduces a positive bias over millions of operations. Banker's Rounding ensures that ties are rounded to the nearest even neighbor, neutralizing the cumulative drift across deep search trees.
- **Implementation**: See `ProbUtils.roundDiv`.

### 3. Atomic Accounting (Remainder Capture)
Whenever `prob` is divided among $N$ branches (e.g., distributing mass across enchantment weights), integer division inevitably produces a remainder.
- **Traditional**: $5 / 2 = 2$ (remainder 1 lost).
- **Honest**: $5 / 2 = 2$. The remainder `1` is explicitly added to the `Rounding` bucket of the current `ProbabilityMassBookkeeper`.
- **Atomic**: All additions to the results map and buckets happen within the same transition block.

### Checkpoint Aggregation

1.  **Modified Level Search**: `SearchService.searchModifiedLevel` returns a reusable `SearchState` with combo results, a node-ID frontier, a `SearchNodeGraph`, and a `SearchStateTracker`.
2.  **Checkpoint Accumulation**: `SearchService.searchToCheckpoint` and `searchSequentialCheckpoints` scale each modified-level state by its probability `P(L)` and merge it into a checkpoint accumulator.
    - Combo mass is merged into the checkpoint result map.
    - `ProbabilityMassAccountant.addScaled` preserves bucket conservation while weighting each modified level.
    - Frontier/graph pairs are retained with their scale so snapshot reporting can describe what remains unexplored.
3.  **Summary/Snapshot Reporting**: `SummaryAggregationService` scans resolved combos and scaled frontiers once to derive public mass buckets; `SummaryService` and `SnapshotService` format those buckets into `CalculationStats` and UI/reporting snapshots.

---

## Advanced Mechanism: Residual Mass Forwarding (The Harvester)

When multiple paths reach the same state (duplicate nodes), the current engine utilizes the **Duplicate Harvester** to prevent "Remainder Fragmentation."

### The Problem of Fragmentation
If two paths reach a node with mass `5` separately, they both split (e.g., $5/2$), losing `1` unit of remainder each. Total lost: `2`.
If they were processed together, the total mass would be `10`, and $10/2 = 5$ with **zero** remainder.

### The Solution: Harvesting
1. **Canonical Node Graph**: Every unique `(enchant bitset << 8 | current level)` node is assigned a dense node ID by `SearchNodeGraph`.
2. **Registry-Selected Identity**: `SearchPoolPlan` chooses `number53` for enchant IDs `0..44` and `bigint64` for IDs `45..63`. The `number53` path stores safe numeric keys plus `maskLo`, `maskHi`, and `level`; the `bigint64` path keeps canonical BigInt meta identity.
3. **Expansion Cache**: Each graph node can cache an `ExpansionBlueprint` with its child node IDs and settlement metadata.
4. **Residue Accumulation**: The graph stores forwarding residue alongside the node, separate from the structural blueprint.
5. **Immediate Forwarding**: When a duplicate path arrives at a cached node, it does not need to re-enter the best-first frontier. `MassForwardingEngine` forwards its mass through the cached blueprint.
6. **Residue Promotion**: The harvester adds incoming remainders to the node residue. When the accumulator exceeds the distribution divisor, it promotes the recovered units back into resolved outcomes.

**This results in higher reported accuracy (`Resolved` mass) as the search deepens.**

---

## Integration and Aggregation

### SearchState
`SearchState` maintains the bookkeeping for a single modified level.
- `results` stores exact combo mass.
- `queue` stores the remaining best-first frontier as node IDs plus probability mass.
- `graph` resolves node IDs to identity state, packed combos, cached blueprints, and forwarding residue. In `number53` mode, BigInt meta is reconstructed lazily only for compatibility/reporting callers.
- `tracker.mass` stores the bucketed probability accounting for that modified level.

### SearchResult
Because Minecraft enchanting uses a triangular distribution of modified levels, a checkpoint `SearchResult` combines many `SearchState` instances.
- It calculates the probability $P(L)$ for each modified level.
- It uses scaled mass accounting to weight each modified-level contribution.
- It retains frontier/graph pairs so unresolved pending mass can still be summarized by combo.
- The same atomic accounting applies here: the remainder of checkpoint weighting is captured into the aggregate `Rounding` bucket.
