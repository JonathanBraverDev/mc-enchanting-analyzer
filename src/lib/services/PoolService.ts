import { RegistryState, PackedEnchant } from '../types/index.js';
import { getEligiblePool } from '../core/registry.js';
import { CacheManager } from './CacheManager.js';

/**
 * Service for registry-aware pool operations and filtering.
 */
export class PoolService {
    constructor(private readonly cache: CacheManager) {}

    /**
     * Retrieves the eligible pool for a category and level, filtered by a conflict bitset.
     */
    public getEligibleListNumeric(registry: RegistryState, cat: string, level: number, bitset: bigint = 0n): number[] {
        const pool = getEligiblePool(registry, cat, level, this.cache, registry.version);
        if (bitset === 0n) return pool;
        
        return pool.filter(p => {
            const id = p >> 8;
            return (bitset & (1n << BigInt(id))) === 0n;
        });
    }
}
