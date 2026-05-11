import { PACKING_CONSTANTS } from '#constants/engine.js';
import { PackedCombo } from '#types/index.js';
import type { PendingFrontierEntry } from '#lib/search/SearchRun.js';

export interface SummaryAggregationRequest {
    combos: ReadonlyMap<PackedCombo, bigint>;
    indexToEnchant: number[];
    /** Native pending entries from the shared search run. */
    pendingEntries?: readonly PendingFrontierEntry[] | undefined;
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
            pendingEntries = [],
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

        for (const entry of pendingEntries) {
            this.addContribution(result, entry.combo, entry.mass, indexToEnchant, true, isBook, includeMasses, includeShownClueDistribution);
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
            // Resolved book combos are exactly post-processed by the engine. Pending book
            // frontier nodes are only safe to harvest as aggregate buckets here: each enchant
            // survives random removal in N-1 of N outcomes, but the raw combo is not final.
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
