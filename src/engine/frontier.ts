import { BinaryHeap, PRECISION, ComboUtils, EnchantUtils } from '../utils/index.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { getEnchantId } from '../core/registry.js';
import { PackedNode, PackedCombo, SearchFrontier, RegistryState } from '../types/index.js';

export class FrontierFactory {
    /**
     * Initializes a new SearchFrontier or clones an existing one.
     */
    public static create(
        registry: RegistryState,
        cat: string,
        modLevel: number,
        guaranteedFirst: string | null,
        existing?: SearchFrontier,
        threshold: bigint = 0n
    ): SearchFrontier {
        if (existing) {
            existing.threshold = threshold;
            existing.iterations = 0;
            existing.checkpoints = [];
            return existing;
        }

        const results = new Map<PackedCombo, bigint>();
        const queue = new BinaryHeap<PackedNode>((item) => item.meta);
        const anyMass = new Map<number, bigint>();
        const rankMass = new Map<number, bigint>();
        const countMass = new Map<number, bigint>();

        const romanMap = registry.data.constants.ROMAN_MAP;
        const parsed = EnchantUtils.parse(guaranteedFirst, romanMap);
        const guaranteedId = parsed ? getEnchantId(registry, parsed.name) : ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID;
        const hasGuaranteed = guaranteedId !== ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID;

        const rank = parsed?.rank ?? 1;
        const full = hasGuaranteed ? (guaranteedId << 8 | rank) : null;

        const initialPacked = full !== null ? ComboUtils.pack([full], guaranteedId, registry.enchantToIndex) : 0;
        const initialBitset = hasGuaranteed ? (1n << BigInt(guaranteedId)) : 0n;

        if (full !== null && hasGuaranteed) {
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
            mass: { 
                resolved: 0n, 
                pending: PRECISION, 
                sieved: 0n, 
                overflow: 0n,
                capped: 0n,
                rounding: 0n 
            },
            threshold,
            iterations: 0,
            nodesProcessed: 0,
            checkpoints: []
        };
    }

    public static getGuaranteedFirstId(registry: RegistryState, guaranteedFirst: string | null): number | null {
        if (!guaranteedFirst) return null;
        const romanMap = registry.data.constants.ROMAN_MAP;
        const parsed = EnchantUtils.parse(guaranteedFirst, romanMap);
        if (!parsed) return null;
        const id = getEnchantId(registry, parsed.name);
        return id !== ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID ? id : null;
    }
}
