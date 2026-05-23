import { PackedCombo, PackedEnchant } from '#types/index.js';
import {
    ENGINE_FRONTIER_KIND,
    type EngineFrontierView,
    type PendingClueJointAggregates,
    type PendingFrontierEntry
} from '#lib/search/SearchRun.js';
import { ComboUtils, ProbUtils, PRECISION } from '#utils/index.js';
import { SummaryAggregationService } from '#services/SummaryAggregationService.js';

/**
 * Service for analyzing clue probabilities and performing clue-conditioned transforms.
 * Separates observation logic from the core generation engine.
 */
export class ClueAnalysisService {
    /**
     * Re-normalizes statistics based on a specific displayed clue.
     * Implements Bayesian conditioning: P(Combo | Clue) = P(Clue | Combo) * P(Combo) / P(Clue).
     *
     * @param combos Combination distribution before clue conditioning.
     * @param targetClueId The packed ID (id << 8 | rank) of the observed clue.
     * @param indexToEnchant Registry mapping.
     */
    public static conditionOnClue(
        combos: ReadonlyMap<PackedCombo, bigint>,
        targetClueId: number,
        indexToEnchant: number[],
        isBook = false,
        pendingEntries: readonly PendingFrontierEntry[] = [],
        frontier?: EngineFrontierView | undefined
    ): {
        combos: ReadonlyMap<PackedCombo, bigint>,
        anyMass: Map<number, bigint>,
        rankMass: Map<number, bigint>,
        countMass: Map<number, bigint>,
        knownSpace: bigint
    } {
        const clueMasses = SummaryAggregationService.aggregate({
            combos,
            indexToEnchant,
            pendingEntries,
            frontier,
            includeMasses: false
        }).shownClueDistribution;
        const pClue = clueMasses.get(targetClueId) ?? 0n;

        const conditionedCombos = new Map<PackedCombo, bigint>();
        const anyMass = new Map<number, bigint>();
        const rankMass = new Map<number, bigint>();
        const countMass = new Map<number, bigint>();

        if (pClue === 0n) {
            return { combos: conditionedCombos, anyMass, rankMass, countMass, knownSpace: 0n };
        }

        let totalMass = 0n;

        for (const [packed, pCombo] of combos.entries()) {
            totalMass += this.processConditionedNode(packed, pCombo, targetClueId, pClue, indexToEnchant, conditionedCombos, anyMass, rankMass, countMass);
        }

        totalMass += this.processPendingFrontier(
            frontier,
            pendingEntries,
            isBook,
            targetClueId,
            pClue,
            indexToEnchant,
            conditionedCombos,
            anyMass,
            rankMass,
            countMass
        );

        // Final normalization to exactly 1.0.
        const remainder = PRECISION - totalMass;
        if (remainder !== 0n && conditionedCombos.size > 0) {
            const [firstPacked] = conditionedCombos.keys();
            if (firstPacked !== undefined) {
                const current = conditionedCombos.get(firstPacked)!;
                const newProb = current + remainder;
                conditionedCombos.set(firstPacked, newProb);

                // Also update aggregated mass to keep them in sync
                const count = ComboUtils.getCount(firstPacked);
                ProbUtils.addItemMass(countMass, count, remainder);
                ComboUtils.forEachEnchant(firstPacked, indexToEnchant, e => {
                    const id = ComboUtils.getEnchantId(e as PackedEnchant);
                    ProbUtils.addItemMass(anyMass, id, remainder);
                    ProbUtils.addItemMass(rankMass, e as number, remainder);
                });
            }
        }

        return {
            combos: conditionedCombos,
            anyMass,
            rankMass,
            countMass,
            knownSpace: pClue
        };
    }

    private static processPendingFrontier(
        frontier: EngineFrontierView | undefined,
        pendingEntries: readonly PendingFrontierEntry[],
        isBook: boolean,
        targetClueId: number,
        pClue: bigint,
        indexToEnchant: number[],
        conditionedCombos: Map<PackedCombo, bigint>,
        anyMass: Map<number, bigint>,
        rankMass: Map<number, bigint>,
        countMass: Map<number, bigint>
    ): bigint {
        if (frontier?.kind === ENGINE_FRONTIER_KIND.FACTORIZED) {
            const clueJoint = frontier.summary.clueJoint;
            return clueJoint?.targetClueId === targetClueId
                ? this.processPendingClueJointAggregate(clueJoint, pClue, anyMass, rankMass, countMass)
                : 0n;
        }

        const entries = frontier?.kind === ENGINE_FRONTIER_KIND.MATERIALIZED
            ? frontier.entries
            : pendingEntries;
        let totalMass = 0n;
        for (const entry of entries) {
            if (isBook && entry.count > 1) {
                totalMass += this.processPendingBookAggregate(entry.combo, entry.mass, targetClueId, pClue, indexToEnchant, anyMass, rankMass, countMass);
                continue;
            }

            totalMass += this.processConditionedNode(entry.combo, entry.mass, targetClueId, pClue, indexToEnchant, conditionedCombos, anyMass, rankMass, countMass);
        }
        return totalMass;
    }

    private static processPendingClueJointAggregate(
        clueJoint: PendingClueJointAggregates,
        pClue: bigint,
        anyMass: Map<number, bigint>,
        rankMass: Map<number, bigint>,
        countMass: Map<number, bigint>
    ): bigint {
        let totalMass = 0n;
        totalMass += this.addNormalizedArrayMass(countMass, clueJoint.count, pClue);
        this.addNormalizedArrayMass(anyMass, clueJoint.any, pClue);
        this.addNormalizedArrayMass(rankMass, clueJoint.ranks, pClue);
        return totalMass;
    }

    private static addNormalizedArrayMass(target: Map<number, bigint>, source: readonly bigint[], pClue: bigint): bigint {
        let totalMass = 0n;
        for (let key = 0; key < source.length; key++) {
            const jointMass = source[key];
            if (jointMass === undefined || jointMass <= 0n) continue;

            const normalizedMass = (jointMass * PRECISION) / pClue;
            if (normalizedMass <= 0n) continue;
            ProbUtils.addItemMass(target, key, normalizedMass);
            totalMass += normalizedMass;
        }
        return totalMass;
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
        const count = ComboUtils.getCount(packed);
        const n = BigInt(count);
        let clueIndex = -1;
        ComboUtils.forEachEnchant(packed, indexToEnchant, (e, i) => {
            if (e === targetClueId) clueIndex = i;
        });
        if (clueIndex === -1) return 0n;

        const share = (pOriginal / n) + (BigInt(clueIndex) < (pOriginal % n) ? 1n : 0n);
        if (share > 0n) {
            const pConditioned = (share * PRECISION) / pClue;
            const existing = conditionedCombos.get(packed) ?? 0n;
            conditionedCombos.set(packed, existing + pConditioned);

            ProbUtils.addItemMass(countMass, count, pConditioned);
            ComboUtils.forEachEnchant(packed, indexToEnchant, e => {
                const id = ComboUtils.getEnchantId(e as PackedEnchant);
                ProbUtils.addItemMass(anyMass, id, pConditioned);
                ProbUtils.addItemMass(rankMass, e as number, pConditioned);
            });
            return pConditioned;
        }
        return 0n;
    }

    private static processPendingBookAggregate(
        packed: PackedCombo,
        pOriginal: bigint,
        targetClueId: number,
        pClue: bigint,
        indexToEnchant: number[],
        anyMass: Map<number, bigint>,
        rankMass: Map<number, bigint>,
        countMass: Map<number, bigint>
    ): bigint {
        const count = ComboUtils.getCount(packed);
        const n = BigInt(count);
        let clueIndex = -1;

        ComboUtils.forEachEnchant(packed, indexToEnchant, (e, i) => {
            if (e === targetClueId) clueIndex = i;
        });
        if (clueIndex === -1) return 0n;

        const share = (pOriginal / n) + (BigInt(clueIndex) < (pOriginal % n) ? 1n : 0n);
        if (share <= 0n) return 0n;

        const pConditioned = (share * PRECISION) / pClue;

        // Pending book nodes are pre-removal branches. Resolved book outcomes are exactly
        // post-processed in the engine; snapshots only keep this aggregate expected value.
        // Richer pending combo harvesting would need a projection-layer design rather than
        // replaying engine blueprints/residue forwarding here.
        const aggregateMass = (pConditioned * BigInt(count - 1)) / n;
        ProbUtils.addItemMass(countMass, count - 1, pConditioned);
        ComboUtils.forEachEnchant(packed, indexToEnchant, e => {
            const id = ComboUtils.getEnchantId(e as PackedEnchant);
            ProbUtils.addItemMass(anyMass, id, aggregateMass);
            ProbUtils.addItemMass(rankMass, e as number, aggregateMass);
        });

        return pConditioned;
    }
}
