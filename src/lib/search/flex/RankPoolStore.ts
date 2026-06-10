import type { SearchPool, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import type { PackedEnchant } from '#types/index.js';

export type RankPoolId = number & { readonly __brand: 'RankPoolId' };

export interface RankPoolStoreMemoryStats {
    readonly poolCount: number;
}

interface RankPoolRecord {
    readonly id: RankPoolId;
    readonly signature: SearchPoolSignature;
    readonly packedByEnchantId: ReadonlyMap<number, PackedEnchant>;
}

/**
 * Interns exact ranked pools for Flex rank-merge projection.
 *
 * The grouped graph can reason about abstract enchant IDs, while projection can
 * recover the exact packed enchantment through `(rankPoolId, enchantId)`.
 */
export class RankPoolStore {
    private readonly idsBySignature = new Map<SearchPoolSignature, RankPoolId>();
    private readonly records: RankPoolRecord[] = [];

    public getOrCreate(pool: SearchPool): RankPoolId {
        const existing = this.idsBySignature.get(pool.signature);
        if (existing !== undefined) return existing;

        const id = this.records.length as RankPoolId;
        const record = Object.freeze({
            id,
            signature: pool.signature,
            packedByEnchantId: this.createEnchantResolver(pool)
        });
        this.records.push(record);
        this.idsBySignature.set(pool.signature, id);
        return id;
    }

    public resolve(id: RankPoolId, enchantId: number): PackedEnchant | null {
        return this.getRecord(id).packedByEnchantId.get(enchantId) ?? null;
    }

    public getSignature(id: RankPoolId): SearchPoolSignature {
        return this.getRecord(id).signature;
    }

    public getMemoryStats(): RankPoolStoreMemoryStats {
        return {
            poolCount: this.records.length
        };
    }

    private createEnchantResolver(pool: SearchPool): ReadonlyMap<number, PackedEnchant> {
        const packedByEnchantId = new Map<number, PackedEnchant>();
        for (const entry of pool.entries) {
            if (packedByEnchantId.has(entry.enchantId)) {
                throw new Error(`RankPoolStore expected one ranked entry for enchant ID ${entry.enchantId}.`);
            }
            packedByEnchantId.set(entry.enchantId, entry.packedEnchant);
        }
        return packedByEnchantId;
    }

    private getRecord(id: RankPoolId): RankPoolRecord {
        const record = this.records[id as number];
        if (!record) throw new Error(`Unknown rank pool ID ${id}.`);
        return record;
    }
}
