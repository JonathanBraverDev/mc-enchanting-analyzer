import { getCandidatePool, getEnchantability } from '#core/registry.js';
import { BIGINT_CONSTANTS, PACKING_CONSTANTS } from '#constants/engine.js';
import { MINECRAFT_RULES } from '#constants/minecraft.js';
import { PackedEnchant, RegistryState } from '#types/index.js';

/** Stable fingerprint for all rules that affect a modified-level enchantment pool. */
export type SearchPoolSignature = string & { readonly __brand: 'SearchPoolSignature' };

/** Stable fingerprint for rank-variant pools that share base structural behavior. */
export type SearchPoolFamilySignature = string & { readonly __brand: 'SearchPoolFamilySignature' };

/** One packed enchantment option plus the precomputed data needed by search graphs. */
export interface SearchPoolEntry {
    readonly packedEnchant: PackedEnchant;
    readonly enchantId: number;
    readonly rank: number;
    readonly weight: number;
    readonly comboIndex: number;
    readonly idBit: bigint;
    readonly conflictBitset: bigint;
    /** Selectable-self plus conflicts: the future eligibility mask added by choosing this entry. */
    readonly blocksBitset: bigint;
}

/** Immutable eligible-enchantment pool for one item at one modified level. */
export interface SearchPool {
    readonly item: string;
    readonly level: number;
    readonly signature: SearchPoolSignature;
    readonly familySignature: SearchPoolFamilySignature;
    readonly entries: readonly SearchPoolEntry[];
    readonly totalWeight: number;
}

/** Modified levels that share the same pool signature and can therefore share a graph. */
export interface SearchPoolGroup {
    readonly signature: SearchPoolSignature;
    readonly levels: readonly number[];
    readonly pool: SearchPool;
}

export interface RegistryKernelRequest {
    readonly registry: RegistryState;
    readonly item: string;
    readonly material: string;
}

/**
 * Request-scoped view of registry data needed by shared search.
 *
 * It converts registry lookups into immutable search pools with stable structural
 * signatures. Search graphs key off those signatures so modified levels with the
 * same eligibility/conflict/weight rules reuse one structural graph.
 */
export class RegistryKernel {
    public readonly registry: RegistryState;
    public readonly version: string;
    public readonly item: string;
    public readonly material: string;
    public readonly enchantability: number;
    public readonly multiEnchantBooks: boolean;
    public readonly additionalEnchantmentLevelDivisor: number;

    private readonly poolCache = new Map<number, SearchPool>();

    public constructor(request: RegistryKernelRequest) {
        this.registry = request.registry;
        this.version = request.registry.version;
        this.item = request.item;
        this.material = request.material;
        this.enchantability = getEnchantability(request.registry, request.material, request.item);
        this.multiEnchantBooks = request.registry.multiEnchantBooks;
        this.additionalEnchantmentLevelDivisor = request.registry.mechanics.additional_enchantment_level_divisor
            ?? MINECRAFT_RULES.ADDITIONAL_ENCHANTMENT_LEVEL_DIVISOR_MODERN;
    }

    public getPool(level: number): SearchPool {
        const cached = this.poolCache.get(level);
        if (cached) return cached;

        const packedPool = getCandidatePool(this.registry, this.item, level);
        const entries = packedPool.map(packedEnchant => this.toPoolEntry(packedEnchant));
        const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
        const signature = this.createPoolSignature(entries);
        const familySignature = this.createPoolFamilySignature(entries);
        const pool: SearchPool = Object.freeze({
            item: this.item,
            level,
            signature,
            familySignature,
            entries: Object.freeze(entries),
            totalWeight
        });

        this.poolCache.set(level, pool);
        return pool;
    }

    /** Groups modified levels by identical pool signature for graph sharing. */
    public groupLevelsByPoolSignature(levels: readonly number[]): SearchPoolGroup[] {
        const groups = new Map<SearchPoolSignature, { levels: number[]; pool: SearchPool }>();

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

    private toPoolEntry(packedEnchant: PackedEnchant): SearchPoolEntry {
        const enchantId = packedEnchant >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        const rank = packedEnchant & PACKING_CONSTANTS.RANK_MASK;
        const weight = this.registry.weightMap[enchantId] ?? 0;
        const comboIndex = this.registry.enchantToIndex.get(packedEnchant) ?? 0;
        const idBit = BIGINT_CONSTANTS.ID_BIT_LOOKUP[enchantId];
        if (idBit === undefined) {
            throw new Error(`RegistryKernel supports enchant IDs 0-${BIGINT_CONSTANTS.ID_BIT_LOOKUP.length - 1}; pool contains ID ${enchantId}.`);
        }

        const conflictBitset = this.registry.conflictBitsets[enchantId] ?? 0n;
        return Object.freeze({
            packedEnchant,
            enchantId,
            rank,
            weight,
            comboIndex,
            idBit,
            conflictBitset,
            blocksBitset: idBit | conflictBitset
        });
    }

    private createPoolSignature(entries: readonly SearchPoolEntry[]): SearchPoolSignature {
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

        return `pool:${fnv1a64(parts.join('|'))}` as SearchPoolSignature;
    }

    private createPoolFamilySignature(entries: readonly SearchPoolEntry[]): SearchPoolFamilySignature {
        const parts = [
            `v=${this.version}`,
            `item=${this.item}`,
            `book=${this.multiEnchantBooks ? 'multi' : 'single'}`,
            ...entries.map(entry => [
                entry.enchantId,
                entry.weight,
                entry.conflictBitset.toString(16)
            ].join(':'))
        ];

        return `pool-family:${fnv1a64(parts.join('|'))}` as SearchPoolFamilySignature;
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
