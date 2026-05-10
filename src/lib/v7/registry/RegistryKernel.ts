import { getEligiblePool, getEnchantability } from '#core/registry.js';
import { BIGINT_CONSTANTS, PACKING_CONSTANTS } from '#constants/engine.js';
import { PackedEnchant, RegistryState } from '#types/index.js';

export type V7PoolSignature = string & { readonly __brand: 'V7PoolSignature' };

export interface V7PoolEntry {
    readonly packedEnchant: PackedEnchant;
    readonly enchantId: number;
    readonly rank: number;
    readonly weight: number;
    readonly comboIndex: number;
    readonly idBit: bigint;
    readonly conflictBitset: bigint;
}

export interface V7PoolProjection {
    readonly item: string;
    readonly level: number;
    readonly signature: V7PoolSignature;
    readonly entries: readonly V7PoolEntry[];
    readonly totalWeight: number;
}

export interface V7PoolGroup {
    readonly signature: V7PoolSignature;
    readonly levels: readonly number[];
    readonly pool: V7PoolProjection;
}

export interface RegistryKernelRequest {
    readonly registry: RegistryState;
    readonly item: string;
    readonly material: string;
}

/**
 * V7 request-scoped registry projection.
 *
 * This is the first seam for the shared-search rewrite: it turns the mutable-looking
 * V6 registry helpers into immutable pool projections with stable structural
 * signatures. Search programs can key off these signatures instead of rebuilding
 * per-modified-level structural work.
 */
export class RegistryKernel {
    public readonly registry: RegistryState;
    public readonly version: string;
    public readonly item: string;
    public readonly material: string;
    public readonly enchantability: number;
    public readonly multiEnchantBooks: boolean;

    private readonly poolCache = new Map<number, V7PoolProjection>();

    public constructor(request: RegistryKernelRequest) {
        this.registry = request.registry;
        this.version = request.registry.version;
        this.item = request.item;
        this.material = request.material;
        this.enchantability = getEnchantability(request.registry, request.material, request.item);
        this.multiEnchantBooks = request.registry.multiEnchantBooks;
    }

    public getPool(level: number): V7PoolProjection {
        const cached = this.poolCache.get(level);
        if (cached) return cached;

        const packedPool = getEligiblePool(this.registry, this.item, level);
        const entries = packedPool.map(packedEnchant => this.createPoolEntry(packedEnchant));
        const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
        const signature = this.createPoolSignature(entries);
        const projection: V7PoolProjection = Object.freeze({
            item: this.item,
            level,
            signature,
            entries: Object.freeze(entries),
            totalWeight
        });

        this.poolCache.set(level, projection);
        return projection;
    }

    public getPoolGroups(levels: readonly number[]): V7PoolGroup[] {
        const groups = new Map<V7PoolSignature, { levels: number[]; pool: V7PoolProjection }>();

        for (const level of levels) {
            const pool = this.getPool(level);
            let group = groups.get(pool.signature);
            if (!group) {
                group = { levels: [], pool };
                groups.set(pool.signature, group);
            }
            group.levels.push(level);
        }

        return [...groups.entries()].map(([signature, group]) => Object.freeze({
            signature,
            levels: Object.freeze([...group.levels]),
            pool: group.pool
        }));
    }

    private createPoolEntry(packedEnchant: PackedEnchant): V7PoolEntry {
        const enchantId = packedEnchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        const rank = packedEnchant & PACKING_CONSTANTS.RANK_MASK;
        const weight = this.registry.weightMap[enchantId] ?? 0;
        const comboIndex = this.registry.enchantToIndex.get(packedEnchant) ?? 0;
        const idBit = BIGINT_CONSTANTS.ID_BIT_LOOKUP[enchantId];
        if (idBit === undefined) {
            throw new Error(`V7 registry kernel supports enchant IDs 0-${BIGINT_CONSTANTS.ID_BIT_LOOKUP.length - 1}; pool contains ID ${enchantId}.`);
        }

        return Object.freeze({
            packedEnchant,
            enchantId,
            rank,
            weight,
            comboIndex,
            idBit,
            conflictBitset: this.registry.conflictBitsets[enchantId] ?? 0n
        });
    }

    private createPoolSignature(entries: readonly V7PoolEntry[]): V7PoolSignature {
        const parts = [
            `v=${this.version}`,
            `item=${this.item}`,
            `book=${this.multiEnchantBooks ? 'multi' : 'single'}`,
            ...entries.map(entry => [
                entry.packedEnchant,
                entry.weight,
                entry.comboIndex,
                entry.conflictBitset.toString(16)
            ].join(':'))
        ];

        return `pool:${fnv1a64(parts.join('|'))}` as V7PoolSignature;
    }
}

function fnv1a64(input: string): string {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;

    for (let i = 0; i < input.length; i++) {
        hash ^= BigInt(input.charCodeAt(i));
        hash = (hash * prime) & mask;
    }

    return hash.toString(16).padStart(16, '0');
}
