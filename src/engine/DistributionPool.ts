/**
 * Shared memory pool for probability distributions during the search process.
 * Uses a multiplexed buffer to allow safe reuse across recursive/nested calls.
 */
export class DistributionPool {
    /**
     * Shared memory pool for probability distributions. 
     * 8 levels of depth (sufficiently covers the 6-enchant limit) x 128 outcomes.
     */
    private static _buffer = new BigUint64Array(8 * 128);

    /**
     * Obtains a subarray view into the shared pool for a specific search depth.
     * 
     * IMPORTANT: The depth modulo 8 ensures that recursive calls (harvesting) don't 
     * clobber the distribution buffers of their parents. Since the maximum 
     * enchantment depth is 6, 8 slots are more than enough to prevent overlaps.
     * 
     * @param depth The current search or recursion depth.
     */
    public static getBuffer(depth: number): BigUint64Array {
        const start = (depth % 8) * 128;
        return DistributionPool._buffer.subarray(start, start + 128);
    }
}
