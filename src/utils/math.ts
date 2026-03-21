/**
 * High-precision constant for BigInt fixed-point arithmetic (2^60)
 */
export const PRECISION = 1n << 60n;

/**
 * Probability conversion helpers for BigInt fixed-point arithmetic.
 */
export const ProbUtils = {
    /**
     * Converts a floating-point probability to a BigInt fixed-point value.
     */
    toBigInt: (p: number): bigint => BigInt(Math.floor(p * Number(PRECISION))),

    /**
     * Converts a BigInt fixed-point value back to a floating-point probability.
     */
    toNumber: (b: bigint): number => Number(b) / Number(PRECISION),

    /**
     * Scales a probability by a fixed-point factor.
     */
    scale: (prob: bigint, factor: bigint): bigint => (prob * factor) / PRECISION
};

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
