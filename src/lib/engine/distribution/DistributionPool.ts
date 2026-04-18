import { POOL_CONSTANTS } from '../../constants/engine.js';

/**
 * Shared memory pool for probability distributions during the search process.
 * Uses a multiplexed buffer to allow safe reuse across recursive/nested calls.
 */
export class DistributionPool {
    /**
     * Shared memory pool for probability distributions. 
     * Uses a fixed number of slots (sufficiently covers the 6-enchant limit) x outcomes per slot.
     */
    private static _buffer = new BigUint64Array(POOL_CONSTANTS.DIST_POOL_DEPTH * POOL_CONSTANTS.DIST_POOL_SLOT_SIZE);

    /**
     * Obtains a subarray view into the shared pool for a specific search depth.
     * 
     * IMPORTANT: The depth modulo DIST_POOL_DEPTH ensures that recursive calls (harvesting) don't 
     * clobber the distribution buffers of their parents. 
     * 
     * @param depth The current search or recursion depth.
     */
    public static getBuffer(depth: number): BigUint64Array {
        const start = (depth % POOL_CONSTANTS.DIST_POOL_DEPTH) * POOL_CONSTANTS.DIST_POOL_SLOT_SIZE;
        return DistributionPool._buffer.subarray(start, start + POOL_CONSTANTS.DIST_POOL_SLOT_SIZE);
    }
}

