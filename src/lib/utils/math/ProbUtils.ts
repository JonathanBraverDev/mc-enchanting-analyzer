import { MATH_CONSTANTS, SEARCH_CONSTANTS } from '#constants/engine.js';
import { MINECRAFT_RULES } from '#constants/minecraft.js';

/**
 * High-precision constant for BigInt fixed-point arithmetic (2^60).
 * Kept together with ProbUtils as they are tightly coupled.
 */
export const PRECISION = 1n << MATH_CONSTANTS.PRECISION_SHIFT;

const addBigUint64ArrayMass = (target: BigUint64Array, key: number, prob: bigint): void => {
    if (!Number.isSafeInteger(key) || key < 0 || key >= target.length) {
        throw new RangeError(`BigUint64Array probability bucket index ${key} is out of bounds`);
    }

    target.set([(target[key] ?? 0n) + prob], key);
};

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
    scale: (prob: bigint, factor: bigint): bigint => {
        if (factor === 0n) return 0n;
        if (factor === PRECISION) return prob;
        return ProbUtils.roundDiv60(prob * factor);
    },

    /**
     * Performs integer division with Banker's Rounding (Round-to-Nearest-Even).
     * Specialized fast-path for PRECISION (2^60) using bitwise logic.
     */
    roundDiv60: (a: bigint): bigint => {
        const q = a >> MATH_CONSTANTS.PRECISION_SHIFT;
        const r = a & (PRECISION - 1n);
        const half = PRECISION >> 1n;

        if (r < half) return q;
        if (r > half) return q + 1n;

        // Exact tie: round to nearest EVEN.
        return (q & 1n) === 0n ? q : q + 1n;
    },

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
        context: { residue: bigint },
        count?: number,
        offset: number = 0
    ): { recovered: bigint } => {
        const total = BigInt(totalWeight);
        const len = count ?? weights.length;

        if (total === 0n) {
            for (let i = 0; i < len; i++) outParts[i] = 0n;
            return { recovered: 0n };
        }

        const oldResidue = context.residue;
        const totalToDistribute = prob + oldResidue;

        let rem = totalToDistribute;
        for (let i = 0; i < len; i++) {
            const w = weights[i + offset] as number | bigint;
            const bigW = typeof w === 'bigint' ? w : BigInt(w!);
            const quotient = (totalToDistribute * bigW) / total;
            outParts[i] = quotient;
            rem -= quotient;
        }

        context.residue = rem;

        // The 'recovered' mass is the difference between what WOULD have been
        // the standalone remainder vs the new residue delta.
        const individualRemainder = prob % total;
        const recovered = individualRemainder - (rem - oldResidue);

        return { recovered: recovered > 0n ? recovered : 0n };
    },

    /**
     * Scales 'val' by 'multiplier' and divides by 'divisor' using Banker's Rounding.
     */
    roundScale: (val: bigint, multiplier: bigint, divisor: bigint): bigint => {
        if (divisor === PRECISION) return ProbUtils.roundDiv60(val * multiplier);
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
            addBigUint64ArrayMass(target, key, prob);
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
            const targetIsArray = target instanceof BigUint64Array;
            for (const [i, mass] of source.entries()) {
                if (mass === 0n) continue;

                const added = hasFactor ? ProbUtils.scale(mass, factor!) : mass;
                if (targetIsArray) {
                    const arr = target as BigUint64Array;
                    addBigUint64ArrayMass(arr, i, added);
                } else {
                    const t = target as Map<number, bigint>;
                    t.set(i, (t.get(i) || 0n) + added);
                }
            }
        } else {
            const targetIsArray = target instanceof BigUint64Array;
            for (const [key, mass] of source) {
                const added = hasFactor ? ProbUtils.scale(mass, factor!) : mass;
                if (targetIsArray) {
                    const arr = target as BigUint64Array;
                    addBigUint64ArrayMass(arr, key, added);
                } else {
                    const t = target as Map<number, bigint>;
                    t.set(key, (t.get(key) || 0n) + added);
                }
            }
        }
    },

    /**
     * Probability table for continuing to add more enchantments at a given modified level.
     */
    PROB_CONTINUE_TABLE: Array.from({ length: SEARCH_CONSTANTS.CONTINUE_TABLE_SIZE }, (_, ml) => {
        const val = Math.min((ml + 1) / MINECRAFT_RULES.CONTINUE_CHANCE_DIVISOR, 1.0);
        const mantissaScale = 2 ** MATH_CONSTANTS.FLOAT_MANTISSA_BITS;
        return BigInt(Math.floor(val * mantissaScale)) << MATH_CONSTANTS.MANTISSA_TO_FIXED_SHIFT;
    })
};
