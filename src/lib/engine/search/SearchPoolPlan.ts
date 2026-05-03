import { BIGINT_CONSTANTS, PACKING_CONSTANTS } from '#constants/engine.js';
import { PackedEnchant, RegistryState } from '#types/index.js';

export type SearchIdentityMode = 'number53' | 'bigint64';

export interface SearchPoolPlanOptions {
    readonly identityModeOverride?: SearchIdentityMode | undefined;
}

/**
 * Per-modified-level expansion metadata derived from the fixed eligible pool.
 * The pool is frozen for the whole search, so node expansion can reuse these arrays.
 */
export class SearchPoolPlan {
    private static readonly NUMBER53_ID_LIMIT = 44;
    private static readonly BIGINT64_ID_LIMIT = 63;
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
    public readonly identityMode: SearchIdentityMode;

    constructor(
        registry: RegistryState,
        pool: PackedEnchant[],
        modLevel: number,
        options: SearchPoolPlanOptions = {}
    ) {
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
        this.assertSupportedMaxId(maxId);

        for (let i = 0; i < pool.length; i++) {
            const enchant = pool[i]!;
            const id = enchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
            this.assertSupportedId(id);
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
        const detectedMode = maxId <= SearchPoolPlan.NUMBER53_ID_LIMIT ? 'number53' : 'bigint64';
        this.identityMode = options.identityModeOverride ?? detectedMode;
        if (this.identityMode === 'number53' && maxId > SearchPoolPlan.NUMBER53_ID_LIMIT) {
            throw new Error(`Search identity mode number53 supports enchant IDs 0-${SearchPoolPlan.NUMBER53_ID_LIMIT}; registry contains ID ${maxId}.`);
        }
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

    private assertSupportedMaxId(maxId: number): void {
        if (maxId > SearchPoolPlan.BIGINT64_ID_LIMIT) {
            throw new Error(`Search identity supports enchant IDs 0-${SearchPoolPlan.BIGINT64_ID_LIMIT}; registry contains ID ${maxId}.`);
        }
    }

    private assertSupportedId(id: number): void {
        if (id > SearchPoolPlan.BIGINT64_ID_LIMIT) {
            throw new Error(`Search identity supports enchant IDs 0-${SearchPoolPlan.BIGINT64_ID_LIMIT}; eligible pool contains ID ${id}.`);
        }
    }
}
