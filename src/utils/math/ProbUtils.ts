/**
 * High-precision constant for BigInt fixed-point arithmetic (2^60).
 * Kept together with ProbUtils as they are tightly coupled.
 */
export const PRECISION = 1n << 60n;

/**
 * Probability conversion helpers for BigInt fixed-point arithmetic.
 */
export const ProbUtils = {
    /**
     * Converts a floating-point probability to a BigInt fixed-point value.
     */
    toBigInt: (p: number): bigint => {
        if (p <= 0) return 0n;
        if (p >= 1) return PRECISION;
        return BigInt(Math.floor(p * 9007199254740992)) << 7n; // 9007199254740992 is 2**53
    },

    /**
     * Converts a BigInt fixed-point value back to a floating-point probability.
     */
    toNumber: (b: bigint): number => Number(b) / Number(PRECISION),

    /**
     * Scales a probability by a fixed-point factor using Banker's Rounding.
     * Statistically neutral across thousands of operations.
     */
    scale: (prob: bigint, factor: bigint): bigint => ProbUtils.roundDiv(prob * factor, PRECISION),

    /**
     * Performs (a * b) / c and returns the remainder.
     * @param a Multiplicand (must be non-negative)
     * @param b Multiplier (must be non-negative)
     * @param c Divisor (must be positive)
     */
    mulDiv: (a: bigint, b: bigint, c: bigint): { quotient: bigint; remainder: bigint } => {
        if (c === 0n) throw new Error("Division by zero in mulDiv");
        const prod = a * b;
        return { quotient: prod / c, remainder: prod % c };
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
     * Splits a probability mass across multiple weights and returns the per-slot remainders.
     * Following the "Honest Accounting" principle, the remainder is NOT redistributed.
     * @param prob The mass to divide
     * @param weights The weight for each slot
     * @param totalWeight The sum of all weights
     * @returns { parts, remainders, remainder } where 'remainder' is the total lost mass
     */
    distributeDetailed: (prob: bigint, weights: number[] | bigint[], totalWeight: number | bigint, count?: number): { parts: bigint[]; remainders: bigint[]; remainder: bigint } => {
        const total = BigInt(totalWeight);
        const len = count ?? weights.length;

        // If no weight exists, mass is entirely unattributable (captured in aggregate remainder)
        if (total === 0n) return { 
            parts: new Array(len).fill(0n), 
            remainders: new Array(len).fill(0n), 
            remainder: prob 
        };

        const parts = new Array<bigint>(len);
        const remainders = new Array<bigint>(len);
        let rem = prob;
        
        for (let i = 0; i < len; i++) {
            const w = weights[i];
            const bigW = typeof w === 'bigint' ? w : BigInt(w!);
            const { quotient, remainder } = ProbUtils.mulDiv(prob, bigW, total);
            parts[i] = quotient;
            remainders[i] = remainder;
            rem -= quotient;
        }
        
        return { parts, remainders, remainder: rem };
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
     * Safely adds probability mass to a Map-based bucket.
     */
    addItemMass: <K>(map: Map<K, bigint>, key: K, prob: bigint): void => {
        map.set(key, (map.get(key) || 0n) + prob);
    },

    /**
     * Merges 'source' map into 'target', optionally scaling values by 'factor' with Banker's Rounding.
     */
    addMapMass: <K>(target: Map<K, bigint>, source: Map<K, bigint>, factor?: bigint): void => {
        for (const [key, mass] of source) {
            const added = (factor !== undefined && factor !== PRECISION)
                ? ProbUtils.scale(mass, factor)
                : mass;
            target.set(key, (target.get(key) || 0n) + added);
        }
    }
};
