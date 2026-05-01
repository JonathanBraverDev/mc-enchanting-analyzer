import { PackedCombo, PackedEnchant } from '#types/index.js';
import { ComboUtils, ProbUtils, PRECISION } from '#utils/index.js';

/**
 * Service for analyzing clue probabilities and performing clue-conditioned transforms.
 * Separates observation logic from the core generation engine.
 */
export class ClueAnalysisService {
    /**
     * Calculates the probability of each enchantment being the shown clue.
     * Derived from the final surviving list of enchantments after generation and transforms.
     *
     * @param combos Map of final combinations and their probabilities (as BigInt units).
     * @param indexToEnchant Mapping from byte indices to packed enchantment IDs.
     * @returns A map of packed enchantment IDs to their clue probabilities.
     */
    public static calculateClueMass(
        combos: Map<PackedCombo, bigint>,
        indexToEnchant: number[],
        frontiers: { heap: import('../utils/collections/SearchHeap.js').SearchHeap, scale: bigint }[] = []
    ): Map<number, bigint> {
        const clueMass = new Map<number, bigint>();

        const addContribution = (packed: PackedCombo, prob: bigint) => {
            if (prob <= 0n) return;
            const enchants = ComboUtils.unpack(packed, indexToEnchant);
            const count = enchants.length;
            if (count === 0) return;

            const quotient = prob / BigInt(count);
            const remainder = prob % BigInt(count);

            for (let i = 0; i < count; i++) {
                const e = enchants[i]!;
                const share = quotient + (BigInt(i) < remainder ? 1n : 0n);
                if (share > 0n) {
                    clueMass.set(e, (clueMass.get(e) ?? 0n) + share);
                }
            }
        };

        for (const [packed, prob] of combos.entries()) {
            addContribution(packed, prob);
        }

        for (const { heap, scale } of frontiers) {
            heap.forEach((_meta, prob, packed) => {
                addContribution(packed as PackedCombo, ProbUtils.scale(prob, scale));
            });
        }

        return clueMass;
    }

    /**
     * Re-normalizes statistics based on a specific displayed clue.
     * Implements Bayesian conditioning: P(Combo | Clue) = P(Clue | Combo) * P(Combo) / P(Clue).
     *
     * @param combos Combination distribution before clue conditioning.
     * @param targetClueId The packed ID (id << 8 | rank) of the observed clue.
     * @param indexToEnchant Registry mapping.
     */
    public static conditionOnClue(
        combos: Map<PackedCombo, bigint>,
        targetClueId: number,
        indexToEnchant: number[],
        frontiers: { heap: import('../utils/collections/SearchHeap.js').SearchHeap, scale: bigint }[] = []
    ): {
        combos: Map<PackedCombo, bigint>,
        anyMass: Map<number, bigint>,
        rankMass: Map<number, bigint>,
        countMass: Map<number, bigint>,
        clueKnownSpace: bigint
    } {
        const clueMasses = this.calculateClueMass(combos, indexToEnchant, frontiers);
        const pClue = clueMasses.get(targetClueId) ?? 0n;

        const conditionedCombos = new Map<PackedCombo, bigint>();
        const anyMass = new Map<number, bigint>();
        const rankMass = new Map<number, bigint>();
        const countMass = new Map<number, bigint>();

        if (pClue === 0n) {
            return { combos: conditionedCombos, anyMass, rankMass, countMass, clueKnownSpace: 0n };
        }

        let totalMass = 0n;

        for (const [packed, pCombo] of combos.entries()) {
            totalMass += this.processConditionedNode(packed, pCombo, targetClueId, pClue, indexToEnchant, conditionedCombos, anyMass, rankMass, countMass);
        }

        for (const { heap, scale } of frontiers) {
            heap.forEach((_meta, prob, packed) => {
                totalMass += this.processConditionedNode(packed as PackedCombo, ProbUtils.scale(prob, scale), targetClueId, pClue, indexToEnchant, conditionedCombos, anyMass, rankMass, countMass);
            });
        }

        // Final normalization to exactly 1.0 (Bit-perfect PRECISION)
        const remainder = PRECISION - totalMass;
        if (remainder !== 0n && conditionedCombos.size > 0) {
            const [firstPacked] = conditionedCombos.keys();
            if (firstPacked !== undefined) {
                const current = conditionedCombos.get(firstPacked)!;
                const newProb = current + remainder;
                conditionedCombos.set(firstPacked, newProb);

                // Also update aggregated mass to keep them in sync
                const enchants = ComboUtils.unpack(firstPacked, indexToEnchant);
                const count = enchants.length;
                ProbUtils.addItemMass(countMass, count, remainder);
                for (const e of enchants) {
                    const id = ComboUtils.getEnchantId(e as PackedEnchant);
                    ProbUtils.addItemMass(anyMass, id, remainder);
                    ProbUtils.addItemMass(rankMass, e as number, remainder);
                }
            }
        }

        return {
            combos: conditionedCombos,
            anyMass,
            rankMass,
            countMass,
            clueKnownSpace: pClue
        };
    }

    private static processConditionedNode(
        packed: PackedCombo,
        pOriginal: bigint,
        targetClueId: number,
        pClue: bigint,
        indexToEnchant: number[],
        conditionedCombos: Map<PackedCombo, bigint>,
        anyMass: Map<number, bigint>,
        rankMass: Map<number, bigint>,
        countMass: Map<number, bigint>
    ): bigint {
        const enchants = ComboUtils.unpack(packed, indexToEnchant);
        const n = BigInt(enchants.length);
        const clueIndex = enchants.indexOf(targetClueId as any);
        if (clueIndex === -1) return 0n;

        const share = (pOriginal / n) + (BigInt(clueIndex) < (pOriginal % n) ? 1n : 0n);
        if (share > 0n) {
            const pConditioned = (share * PRECISION) / pClue;
            const existing = conditionedCombos.get(packed) ?? 0n;
            conditionedCombos.set(packed, existing + pConditioned);

            const count = enchants.length;
            ProbUtils.addItemMass(countMass, count, pConditioned);
            for (const e of enchants) {
                const id = ComboUtils.getEnchantId(e as PackedEnchant);
                ProbUtils.addItemMass(anyMass, id, pConditioned);
                ProbUtils.addItemMass(rankMass, e as number, pConditioned);
            }
            return pConditioned;
        }
        return 0n;
    }
}
