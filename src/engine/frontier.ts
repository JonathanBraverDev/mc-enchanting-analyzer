import { BinaryHeap, PRECISION, ComboUtils, RomanUtils } from '../utils/index.js';
import { Registry } from '../core/registry.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { PackedNode, PackedCombo } from '../types/index.js';

/**
 * State of a search for enchantment combinations.
 */
export interface SearchFrontier {
    queue: BinaryHeap<PackedNode>;
    results: Map<PackedCombo, bigint>;
    anyMass: Map<number, bigint>;
    rankMass: Map<number, bigint>;
    countMass: Map<number, bigint>;
    uncertainty: bigint;
    cumulativeAccountedMass: bigint;
    prunedMass: bigint;
    roundingError: bigint;
    threshold: bigint;
}

export class FrontierFactory {
    /**
     * Initializes a new SearchFrontier or clones an existing one.
     */
    public static create(
        registry: Registry,
        cat: string,
        modLevel: number,
        guaranteedFirst: string | null,
        existing?: SearchFrontier,
        threshold: bigint = 0n
    ): SearchFrontier {
        if (existing) {
            return {
                queue: existing.queue.clone(),
                results: new Map(existing.results),
                anyMass: new Map(existing.anyMass),
                rankMass: new Map(existing.rankMass),
                countMass: new Map(existing.countMass),
                uncertainty: existing.uncertainty,
                cumulativeAccountedMass: existing.cumulativeAccountedMass,
                prunedMass: existing.prunedMass || 0n,
                roundingError: existing.roundingError || 0n,
                threshold: existing.threshold
            };
        }

        const results = new Map<PackedCombo, bigint>();
        const queue = new BinaryHeap<PackedNode>((item) => item.meta);
        const anyMass = new Map<number, bigint>();
        const rankMass = new Map<number, bigint>();
        const countMass = new Map<number, bigint>();

        const romanMap = registry.data.constants.ROMAN_MAP;
        const guaranteedId = this.getGuaranteedFirstId(registry, guaranteedFirst);
        
        const rankStr = guaranteedFirst?.split(' ').pop();
        const rank = rankStr ? RomanUtils.getRomanValue(rankStr, romanMap) : null;
        const full = (guaranteedId !== null && rank !== null) ? (guaranteedId << 8 | rank) : null;

        const initialPacked = full !== null ? ComboUtils.pack([full], guaranteedId) : 0n;
        const initialBitset = guaranteedId !== null ? (1n << BigInt(guaranteedId)) : 0n;

        if (full !== null && guaranteedId !== null) {
            anyMass.set(guaranteedId, PRECISION);
            rankMass.set(full, PRECISION);
        }

        queue.push({
            packedChosen: initialPacked,
            meta: (initialBitset << 8n) | BigInt(modLevel),
            prob: PRECISION
        });

        return { 
            queue, results, anyMass, rankMass, countMass,
            uncertainty: 0n, cumulativeAccountedMass: 0n, prunedMass: 0n, roundingError: 0n, threshold 
        };
    }

    public static getGuaranteedFirstId(registry: Registry, guaranteedFirst: string | null): number | null {
        if (!guaranteedFirst) return null;
        const romanMap = registry.data.constants.ROMAN_MAP;
        const base = RomanUtils.getBaseName(guaranteedFirst, romanMap);
        const id = registry.getEnchantId(base);
        return id !== ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID ? id : null;
    }
}
