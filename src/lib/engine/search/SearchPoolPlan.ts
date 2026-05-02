import { BIGINT_CONSTANTS, PACKING_CONSTANTS } from '#constants/engine.js';
import { PackedEnchant, RegistryState } from '#types/index.js';

/**
 * Per-modified-level expansion metadata derived from the fixed eligible pool.
 * The pool is frozen for the whole search, so node expansion can reuse these arrays.
 */
export class SearchPoolPlan {
    public readonly pool: PackedEnchant[];
    public readonly ids: Uint8Array;
    public readonly idBits: BigUint64Array;
    public readonly conflictBitsets: BigUint64Array;
    public readonly weights: Int32Array;
    public readonly initialMetas: BigUint64Array;
    public readonly singleCombos: Float64Array;
    public readonly initialTotalWeight: number;

    constructor(registry: RegistryState, pool: PackedEnchant[], modLevel: number) {
        this.pool = pool;
        this.ids = new Uint8Array(pool.length);
        this.idBits = new BigUint64Array(pool.length);
        this.conflictBitsets = new BigUint64Array(pool.length);
        this.weights = new Int32Array(pool.length);
        this.initialMetas = new BigUint64Array(pool.length);
        this.singleCombos = new Float64Array(pool.length);

        const initialLevelBits = BIGINT_CONSTANTS.LEVEL_LOOKUP[modLevel]!;
        let initialTotalWeight = 0;

        for (let i = 0; i < pool.length; i++) {
            const enchant = pool[i]!;
            const id = enchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
            const idBit = BIGINT_CONSTANTS.ID_BIT_LOOKUP[id]!;
            const weight = registry.weightMap[id] ?? 0;

            this.ids[i] = id;
            this.idBits[i] = idBit;
            this.conflictBitsets[i] = registry.conflictBitsets[id] ?? 0n;
            this.weights[i] = weight;
            this.initialMetas[i] = (idBit << BIGINT_CONSTANTS.ENCHANT_SHIFT) | initialLevelBits;
            this.singleCombos[i] = registry.enchantToIndex.get(enchant) ?? 0;
            initialTotalWeight += weight;
        }

        this.initialTotalWeight = initialTotalWeight;
    }

    public get length(): number {
        return this.pool.length;
    }
}
