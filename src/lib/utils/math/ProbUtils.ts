import { MATH_CONSTANTS, SEARCH_CONSTANTS, ENGINE_LIMITS } from '#constants/engine.js';

/**
 * High-precision constant for BigInt fixed-point arithmetic (2^60).
 * Kept together with ProbUtils as they are tightly coupled.
 */
export const PRECISION = 1n << MATH_CONSTANTS.PRECISION_SHIFT;

/**
 * Probability conversion helpers for BigInt fixed-point arithmetic.
 */
export const ProbUtils = {
    /**
     * Converts a floating-point probability to a BigInt fixed-point value.
     */
    toBigInt: (p: number | bigint): bigint => {
        if (typeof p === 'bigint') return p;
        if (p <= 0) return 0n;
        if (p >= 1) return PRECISION;
        
        // Use FLOAT_MANTISSA_BITS to capture full double precision before shifting to target PRECISION
        const mantissaScale = 2 ** MATH_CONSTANTS.FLOAT_MANTISSA_BITS;
        return BigInt(Math.floor(p * mantissaScale)) << MATH_CONSTANTS.MANTISSA_TO_FIXED_SHIFT;
    },


    /**
     * Converts a BigInt fixed-point value back to a floating-point probability.
     */
    toNumber: (b: bigint | number): number => {
        if (typeof b === 'number') return b;
        return Number(b) / Number(PRECISION);
    },

    /**
     * Scales a probability by a fixed-point factor using Banker's Rounding.
     * Statistically neutral across thousands of operations.
     */
    scale: (prob: bigint, factor: bigint): bigint => ProbUtils.roundDiv(prob * factor, PRECISION),

    /**
     * Performs integer division with Banker's Rounding (Round-to-Nearest-Even).
     * Uses the (r * 2) vs b comparison to handle odd denominators symmetrically.
     * @param a Dividend (must be non-negative)
     * @param b Divisor (must be positive)
     */
    roundDiv: (a: bigint, b: bigint): bigint => {
        if (b === 0n) throw new Error("Division by zero in roundDiv");
        
        const q = a / b;
        const r = a % b;
        const doubleR = r * 2n;

        if (doubleR < b) return q;
        if (doubleR > b) return q + 1n;
        
        // Exact tie (doubleR == b). Round to the nearest EVEN neighbor.
        return (q % 2n === 0n) ? q : q + 1n;
    },

    /**
     * Splits a probability mass across multiple weights into the provided output array.
     * Following the "Honest Accounting" principle, the remainder is NOT redistributed.
     * @param prob The mass to divide
     * @param weights The weight for each slot
     * @param totalWeight The sum of all weights
     * @param outParts The output array to store the distributed mass parts
     * @returns The total lost mass (remainder)
     */
    distributeDetailed: (
        prob: bigint, 
        weights: ArrayLike<number | bigint>, 
        totalWeight: number | bigint, 
        outParts: bigint[] | BigUint64Array,
        count?: number
    ): bigint => {
        const total = BigInt(totalWeight);
        const len = count ?? weights.length;

        if (total === 0n) {
            for (let i = 0; i < len; i++) outParts[i] = 0n;
            return prob;
        }

        let rem = prob;
        for (let i = 0; i < len; i++) {
            const w = weights[i] as number | bigint;
            const bigW = typeof w === 'bigint' ? w : BigInt(w!);
            const quotient = (prob * bigW) / total;
            outParts[i] = quotient;
            rem -= quotient;
        }
        
        return rem;
    },

    /**
     * Splits probability mass across multiple weights using a stateful residue accumulator.
     * This allows "recovering" fragmented mass by combining remainders from successive arrivals.
     * @returns { recovered: bigint } The amount of mass recovered from previous rounding losses.
     */
    distributeWithResidue: (
        prob: bigint,
        weights: ArrayLike<number | bigint>,
        totalWeight: number | bigint,
        outParts: bigint[] | BigUint64Array,
        oldResidue: bigint,
        count?: number
    ): { recovered: bigint; newResidue: bigint } => {
        const total = BigInt(totalWeight);
        const len = count ?? weights.length;

        if (total === 0n) {
            for (let i = 0; i < len; i++) outParts[i] = 0n;
            return { recovered: 0n, newResidue: 0n };
        }

        const totalToDistribute = prob + oldResidue;
        
        let rem = totalToDistribute;
        for (let i = 0; i < len; i++) {
            const w = weights[i] as number | bigint;
            const bigW = typeof w === 'bigint' ? w : BigInt(w!);
            const quotient = (totalToDistribute * bigW) / total;
            outParts[i] = quotient;
            rem -= quotient;
        }
        
        const newResidue = rem;
        const individualRemainder = prob % total;
        const recovered = individualRemainder - (newResidue - oldResidue);

        return { recovered: recovered > 0n ? recovered : 0n, newResidue };
    },
    /**
     * Scales 'val' by 'multiplier' and divides by 'divisor' using Banker's Rounding.
     */
    roundScale: (val: bigint, multiplier: bigint, divisor: bigint): bigint => {
        return ProbUtils.roundDiv(val * multiplier, divisor);
    },

    /**
     * Minecraft specific rounding: (int)(final_level + 0.5f).
     * Rounds to nearest integer, with ties rounding towards positive infinity.
     */
    mcRound: (val: number): number => {
        return Math.floor(val + 0.5);
    },

    /**
     * Safely adds probability mass to a Map or BigUint64Array bucket.
     */
    addItemMass: (target: Map<number, bigint> | BigUint64Array, key: number, prob: bigint): void => {
        if (target instanceof BigUint64Array) {
            target[key]! += prob;
        } else {
            target.set(key, (target.get(key) || 0n) + prob);
        }
    },

    /**
     * Merges 'source' map/array into 'target', optionally scaling values by 'factor' with Banker's Rounding.
     */
    addMapMass: (
        target: Map<number, bigint> | BigUint64Array, 
        source: Map<number, bigint> | BigUint64Array, 
        factor?: bigint
    ): void => {
        const hasFactor = factor !== undefined && factor !== PRECISION;

        if (source instanceof BigUint64Array) {
            const len = source.length;
            if (target instanceof BigUint64Array) {
                for (let i = 0; i < len; i++) {
                    const mass = source[i]!;
                    if (mass === 0n) continue;
                    target[i]! += hasFactor ? ProbUtils.scale(mass, factor!) : mass;
                }
            } else {
                for (let i = 0; i < len; i++) {
                    const mass = source[i]!;
                    if (mass === 0n) continue;
                    const added = hasFactor ? ProbUtils.scale(mass, factor!) : mass;
                    target.set(i, (target.get(i) || 0n) + added);
                }
            }
        } else {
            if (target instanceof BigUint64Array) {
                for (const [key, mass] of source) {
                    target[key]! += hasFactor ? ProbUtils.scale(mass, factor!) : mass;
                }
            } else {
                for (const [key, mass] of source) {
                    const added = hasFactor ? ProbUtils.scale(mass, factor!) : mass;
                    target.set(key, (target.get(key) || 0n) + added);
                }
            }
        }
    },

    /**
     * Pre-computed BigInt versions of search constants to avoid repeated conversion.
     */
    CHECKPOINT_TARGETS: SEARCH_CONSTANTS.CHECKPOINT_TARGET_FLOATS.map(t => {
        if (t <= 0) return 0n;
        if (t >= 1) return PRECISION;
        const mantissaScale = 2 ** MATH_CONSTANTS.FLOAT_MANTISSA_BITS;
        return BigInt(Math.floor(t * mantissaScale)) << MATH_CONSTANTS.MANTISSA_TO_FIXED_SHIFT;
    }),

    /**
     * Probability table for continuing to add more enchantments at a given modified level.
     */
    PROB_CONTINUE_TABLE: Array.from({ length: SEARCH_CONSTANTS.CONTINUE_TABLE_SIZE }, (_, ml) => {
        const val = Math.min((ml + 1) / ENGINE_LIMITS.MAX_MODIFIED_LEVEL, 1.0);
        // Manual conversion to avoid referencing ProbUtils.toBigInt during initialization if it causes issues
        const mantissaScale = 2 ** MATH_CONSTANTS.FLOAT_MANTISSA_BITS;
        return BigInt(Math.floor(val * mantissaScale)) << MATH_CONSTANTS.MANTISSA_TO_FIXED_SHIFT;
    })
};

