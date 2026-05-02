import { BIGINT_CONSTANTS, PACKING_CONSTANTS } from '#constants/engine.js';
import { PackedEnchant, RegistryState } from '#types/index.js';

/**
 * Per-modified-level expansion metadata derived from the fixed eligible pool.
 * The pool is frozen for the whole search, so node expansion can reuse these arrays.
 */
export class SearchPoolPlan {
    private static readonly NUMERIC_ID_LIMIT = 44;
    private static readonly LOW_MASK_BITS = 32n;
    private static readonly LOW_MASK = 0xFFFFFFFFn;

    public readonly pool: PackedEnchant[];
    public readonly ids: Uint8Array;
    public readonly idBits: BigUint64Array;
    public readonly idMaskLo: Uint32Array;
    public readonly idMaskHi: Uint32Array;
    public readonly conflictBitsets: BigUint64Array;
    public readonly conflictMaskLo: Uint32Array;
    public readonly conflictMaskHi: Uint32Array;
    public readonly weights: Int32Array;
    public readonly comboIndices: Uint8Array;
    public readonly initialMetas: BigUint64Array;
    public readonly singleCombos: Float64Array;
    public readonly initialTotalWeight: number;
    public readonly initialLevel: number;
    public readonly numericIdentitySupported: boolean;

    constructor(registry: RegistryState, pool: PackedEnchant[], modLevel: number) {
        this.pool = pool;
        this.ids = new Uint8Array(pool.length);
        this.idBits = new BigUint64Array(pool.length);
        this.idMaskLo = new Uint32Array(pool.length);
        this.idMaskHi = new Uint32Array(pool.length);
        this.conflictBitsets = new BigUint64Array(pool.length);
        this.conflictMaskLo = new Uint32Array(pool.length);
        this.conflictMaskHi = new Uint32Array(pool.length);
        this.weights = new Int32Array(pool.length);
        this.comboIndices = new Uint8Array(pool.length);
        this.initialMetas = new BigUint64Array(pool.length);
        this.singleCombos = new Float64Array(pool.length);
        this.initialLevel = modLevel;

        const initialLevelBits = BIGINT_CONSTANTS.LEVEL_LOOKUP[modLevel]!;
        let initialTotalWeight = 0;
        let maxId = this.getMaxRegistryId(registry);

        for (let i = 0; i < pool.length; i++) {
            const enchant = pool[i]!;
            const id = enchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
            const idBit = BIGINT_CONSTANTS.ID_BIT_LOOKUP[id]!;
            const conflictBitset = registry.conflictBitsets[id] ?? 0n;
            const weight = registry.weightMap[id] ?? 0;
            const comboIndex = registry.enchantToIndex.get(enchant) ?? 0;

            if (id > maxId) maxId = id;
            this.ids[i] = id;
            this.idBits[i] = idBit;
            this.idMaskLo[i] = SearchPoolPlan.idMaskLo(id);
            this.idMaskHi[i] = SearchPoolPlan.idMaskHi(id);
            this.conflictBitsets[i] = conflictBitset;
            this.conflictMaskLo[i] = Number(conflictBitset & SearchPoolPlan.LOW_MASK);
            this.conflictMaskHi[i] = Number((conflictBitset >> SearchPoolPlan.LOW_MASK_BITS) & SearchPoolPlan.LOW_MASK);
            this.weights[i] = weight;
            this.comboIndices[i] = comboIndex;
            this.initialMetas[i] = (idBit << BIGINT_CONSTANTS.ENCHANT_SHIFT) | initialLevelBits;
            this.singleCombos[i] = comboIndex;
            initialTotalWeight += weight;
        }

        this.initialTotalWeight = initialTotalWeight;
        this.numericIdentitySupported = maxId <= SearchPoolPlan.NUMERIC_ID_LIMIT;
    }

    public get length(): number {
        return this.pool.length;
    }

    private getMaxRegistryId(registry: RegistryState): number {
        let maxId = -1;
        const idMap = registry.idMap;
        if (!idMap) return maxId;

        for (const id of idMap.values()) {
            if (id > maxId) maxId = id;
        }

        return maxId;
    }

    private static idMaskLo(id: number): number {
        return id < 32 ? 2 ** id : 0;
    }

    private static idMaskHi(id: number): number {
        return id >= 32 ? 2 ** (id - 32) : 0;
    }
}
