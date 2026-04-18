import { SearchHeap } from '#utils/collections/SearchHeap.js';
import { PRECISION, ComboUtils, EnchantUtils } from '#utils/index.js';
import { PACKING_CONSTANTS } from '#constants/engine.js';
import { ENGINE_DEFAULTS } from '#core/config.js';
import { getEnchantId } from '#core/registry.js';
import { PackedCombo, PackedEnchant, SearchState, RegistryState } from '#types/index.js';
import { SearchManager } from './SearchManager.js';

export class StateFactory {
    /**
     * Initializes a new SearchState or clones an existing one.
     */
    public static create(
        registry: RegistryState,
        
        modLevel: number,
        guaranteedFirst: string | null,
        existing?: SearchState,
        threshold: bigint = 0n
    ): SearchState {
        if (existing) {
            return {
                queue: existing.queue.clone(),
                results: new Map(existing.results),
                anyMass: new BigUint64Array(existing.anyMass),
                rankMass: new BigUint64Array(existing.rankMass),
                countMass: new BigUint64Array(existing.countMass),
                tracker: existing.tracker.clone(),
                threshold,
                iterations: 0,
                nodesProcessed: existing.nodesProcessed,
                checkpoints: []
            };
        }

        const results = new Map<PackedCombo, bigint>();
        const queue = new SearchHeap();
        const anyMass = new BigUint64Array(PACKING_CONSTANTS.BYTE_BASIS);
        const rankMass = new BigUint64Array(PACKING_CONSTANTS.MAX_RANKED_INDEX);
        const countMass = new BigUint64Array(PACKING_CONSTANTS.MAX_COUNT_INDEX);

        const romanMap = registry.data.constants.ROMAN_MAP;
        const parsed = EnchantUtils.parse(guaranteedFirst, romanMap);
        const guaranteedId = parsed ? getEnchantId(registry, parsed.name) : ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID;
        const hasGuaranteed = guaranteedId !== ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID;

        const rank = parsed?.rank ?? 1;
        const full = hasGuaranteed ? (guaranteedId << PACKING_CONSTANTS.ENCHANT_SHIFT | rank) as PackedEnchant : null;

        const initialPacked = full !== null ? ComboUtils.pack([full], guaranteedId, registry.enchantToIndex) : 0 as PackedCombo;
        const initialBitset = hasGuaranteed ? (1n << BigInt(guaranteedId)) : 0n;

        if (full !== null && hasGuaranteed) {
            anyMass[guaranteedId] = PRECISION;
            rankMass[full] = PRECISION;
        }

        queue.pushOrMerge((initialBitset << BigInt(PACKING_CONSTANTS.ENCHANT_SHIFT)) | BigInt(modLevel), PRECISION, modLevel, initialPacked);

        return {
            queue, results, anyMass, rankMass, countMass,
            tracker: new SearchManager({ 
                resolved: 0n, 
                pending: PRECISION, 
                sieved: 0n, 
                overflow: 0n,
                capped: 0n,
                rounding: 0n,
                recoveredRounding: 0n,
                recoveredSieved: 0n
            }),
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
