import { SearchHeap } from '#utils/collections/SearchHeap.js';
import { PRECISION } from '#utils/index.js';
import { PACKING_CONSTANTS } from '#constants/engine.js';
import { PackedCombo, SearchState } from '#types/index.js';
import { SearchManager } from './SearchManager.js';

export class StateFactory {
    /**
     * Initializes a new SearchState or clones an existing one.
     */
    public static create(
        modLevel: number,
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

        // Always start from an empty generation state (0 packed, 0 bitset)
        const initialPacked = 0 as PackedCombo;
        const initialBitset = 0n;

        queue.pushOrMerge((initialBitset << 8n) | BigInt(modLevel), PRECISION, initialPacked);

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
                recoveredSieved: 0n,
                clueKnownSpace: 0n
            }),
            threshold,
            iterations: 0,
            nodesProcessed: 0,
            checkpoints: []
        };
    }
}
