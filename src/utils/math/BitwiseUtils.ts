/**
 * Utility for bitwise operations on BigInts.
 */
export class BitwiseUtils {
    /**
     * Returns a bitset with only the bit at the given index set.
     */
    static getBitset(id: number): bigint {
        return 1n << BigInt(id);
    }
}
