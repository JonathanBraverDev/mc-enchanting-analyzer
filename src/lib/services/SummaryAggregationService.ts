import { PACKING_CONSTANTS } from '#constants/engine.js';
import { PackedCombo, SearchFrontierSnapshot } from '#types/index.js';
import { ProbUtils } from '#utils/index.js';

export interface SummaryAggregationRequest {
    combos: Map<PackedCombo, bigint>;
    indexToEnchant: number[];
    frontiers?: SearchFrontierSnapshot[] | undefined;
    isBook?: boolean | undefined;
    includeMasses?: boolean | undefined;
    includeShownClueDistribution?: boolean | undefined;
}

export interface SummaryAggregationResult {
    any: bigint[];
    ranks: bigint[];
    count: bigint[];
    shownClueDistribution: Map<number, bigint>;
}

/**
 * Shared scanner for public summary projections.
 */
export class SummaryAggregationService {
    public static aggregate(request: SummaryAggregationRequest): SummaryAggregationResult {
        const {
            combos,
            indexToEnchant,
            frontiers = [],
            isBook = false,
            includeMasses = true,
            includeShownClueDistribution = true
        } = request;

        const result: SummaryAggregationResult = {
            any: [],
            ranks: [],
            count: [],
            shownClueDistribution: new Map()
        };

        for (const [packed, mass] of combos) {
            this.addContribution(result, packed, mass, indexToEnchant, false, isBook, includeMasses, includeShownClueDistribution);
        }

        for (const { frontier, graph, scale } of frontiers) {
            frontier.forEachNode((nodeId, prob) => {
                const mass = ProbUtils.scale(prob, scale);
                this.addContribution(result, graph.getCombo(nodeId), mass, indexToEnchant, true, isBook, includeMasses, includeShownClueDistribution);
            });
        }

        return result;
    }

    private static addContribution(
        result: SummaryAggregationResult,
        packed: PackedCombo,
        mass: bigint,
        indexToEnchant: number[],
        isPending: boolean,
        isBook: boolean,
        includeMasses: boolean,
        includeShownClueDistribution: boolean
    ): void {
        if (mass <= 0n) return;

        const count = this.getCount(packed);

        let aggregateMass = mass;
        let displayCount = count;
        if (isPending && isBook && count > 1) {
            aggregateMass = (mass * BigInt(count - 1)) / BigInt(count);
            displayCount = count - 1;
        }

        if (includeMasses) {
            this.addArrayMass(result.count, displayCount, mass);
        }

        const needsEnchantScan = count > 0 && (includeMasses || includeShownClueDistribution);
        if (!needsEnchantScan) return;

        const clueQuotient = includeShownClueDistribution ? mass / BigInt(count) : 0n;
        const clueRemainder = includeShownClueDistribution ? Number(mass % BigInt(count)) : 0;

        let mult = 1;
        for (let i = 0; i < count; i++, mult *= PACKING_CONSTANTS.BYTE_BASIS) {
            const idx = Math.floor(packed / mult) % PACKING_CONSTANTS.BYTE_BASIS;
            const enchant = indexToEnchant[idx];
            if (enchant === undefined) break;

            if (includeMasses) {
                const id = enchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
                this.addArrayMass(result.any, id, aggregateMass);
                this.addArrayMass(result.ranks, enchant, aggregateMass);
            }

            if (includeShownClueDistribution) {
                const share = clueQuotient + (i < clueRemainder ? 1n : 0n);
                if (share > 0n) {
                    result.shownClueDistribution.set(enchant, (result.shownClueDistribution.get(enchant) ?? 0n) + share);
                }
            }
        }
    }

    private static getCount(packed: PackedCombo): number {
        let mult = 1;
        for (let i = 0; i < PACKING_CONSTANTS.MAX_COMBO_SLOTS; i++, mult *= PACKING_CONSTANTS.BYTE_BASIS) {
            if (Math.floor(packed / mult) % PACKING_CONSTANTS.BYTE_BASIS === 0) return i;
        }
        return PACKING_CONSTANTS.MAX_COMBO_SLOTS;
    }

    private static addArrayMass(target: bigint[], key: number, mass: bigint): void {
        target[key] = (target[key] ?? 0n) + mass;
    }
}
