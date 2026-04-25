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

### 2. Banker's Rounding (Statistically Neutral)
The engine implements **Banker's Rounding** (Round-to-Nearest-Even) for scaling operations. 
- **The Why**: Standard "round half up" introduces a positive bias over millions of operations. Banker's Rounding ensures that ties are rounded to the nearest even neighbor, neutralizing the cumulative drift across deep search trees.
- **Implementation**: See `ProbUtils.roundDiv`.

### 3. Atomic Accounting (Remainder Capture)
Whenever `prob` is divided among $N$ branches (e.g., distributing mass across enchantment weights), integer division inevitably produces a remainder.
- **Traditional**: $5 / 2 = 2$ (remainder 1 lost).
- **Honest**: $5 / 2 = 2$. The remainder `1` is explicitly added to the `Rounding` bucket of the current `ProbabilityMassBookkeeper`.
- **Atomic**: All additions to the results map and buckets happen within the same transition block.

### Tiers of Aggregation

1.  **Search Level**: `SearchService` populates a `SearchFrontier` with results and its own `ProbabilityMassBookkeeper`.
2.  **Engine Level**: `ProgressiveStatsAggregator` combines multiple frontiers.
    - Every `addItemMass` call ensures the specific enchantment stats are updated in sync with the global `ProbabilityMassBookkeeper`.
    - After searching all modified levels $L$, the engine has a set of frontiers $\{F_L\}$.
    - It uses `ProbabilityMassBookkeeper.addScaled(frontier, P(L))` to weight each frontier's contribution.

---

## Advanced Mechanism: Residual Mass Forwarding (The Harvester)

When multiple paths reach the same state (duplicate nodes), the current engine utilizes the **Duplicate Harvester** to prevent "Remainder Fragmentation."

### The Problem of Fragmentation
If two paths reach a node with mass `5` separately, they both split (e.g., $5/2$), losing `1` unit of remainder each. Total lost: `2`.
If they were processed together, the total mass would be `10`, and $10/2 = 5$ with **zero** remainder.

### The Solution: Harvesting
1. **Expansion Cache**: Every unique node expansion is cached as an `ExpansionBlueprint`.
2. **Residue Accumulation**: Blueprints store a `residualMass` accumulator.
3. **Immediate Forwarding**: When a duplicate path arrives at a cached node, it doesn't enter the heap. Instead, its mass is "harvested" according to the blueprint.
4. **Residue Promotion**: The harvester adds incoming remainders to the `residualMass`. When the accumulator exceeds the distribution divisor, it "promotes" the recovered units back into the `Resolved` outcomes.

**This results in higher reported accuracy (`Resolved` mass) as the search deepens.**

---

## Integration and Aggregation

### SearchFrontier
The `SearchFrontier` maintains the `MassBookkeeping` for a single search tier.
- It provides `anyMass`, `rankMass`, and `countMass` maps which are themselves `BigUint64Array` buckets.
- Every `addItemMass` call ensures the specific enchantment stats are updated in sync with the global `MassAccountant`.

### StatAggregator
Because Minecraft enchanting involves a triangular distribution of "Modified Levels," the `StatAggregator` combines multiple searches.
- It calculates the probability $P(L)$ for each level.
- It uses `MassAccountant.addScaled(frontier, P(L))` to weight each frontier's contribution.
- The same "Atomic Accounting" applies here: the remainder of the tier-weighting multiplication is captured into the aggregate `Rounding` bucket.
