import { PRECISION, ProbUtils } from '../utils/index.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { RegistryState } from '../types/index.js';

/**
 * Service for calculating the probability distribution of Modified Levels.
 */
export class DistributionService {
    private static _splitsBuffer = new BigUint64Array(1024);
    /**
     * Calculates the probability distribution of Modified Levels.
     */
    public static getModifiedLevelDist(
        version: string,
        xp: number, 
        enchantability: number, 
        registry: RegistryState, 
        cache?: { getDist(v: string, k: string): { [level: number]: bigint } | undefined; setDist(v: string, k: string, val: { [level: number]: bigint }): void }
    ): { [level: number]: bigint } {
        const mech = registry.mechanics;
        const key = `${xp}@${enchantability}@${mech.enchantability_bonus_divisor}@${mech.random_bonus_range}`;
        const cached = cache ? cache.getDist(version, key) : undefined;
        if (cached) return cached;

        // 1.0 in BigInt fixed-point
        if (enchantability <= 0) return { [xp]: PRECISION };
        
        const div = mech.enchantability_bonus_divisor ?? 4;
        const rngRange = mech.random_bonus_range ?? 0.15;

        const N = Math.floor(enchantability / div) + 1;
        
        // 1. Base enchantability bonus distribution (Triangular U[0, N-1] + U[0, N-1])
        const baseValues: number[] = [];
        for (let k = 0; k <= 2 * N - 2; k++) baseValues.push(xp + k + 1);
        
        const baseWeights = this.getTriangularWeights(N);
        const totalBaseWeight = BigInt(N * N);
        const baseRemainder = ProbUtils.distributeDetailed(PRECISION, baseWeights, totalBaseWeight, DistributionService._splitsBuffer);
        
        const baseDistMap = new Map<number, bigint>();
        for (let i = 0; i < baseValues.length; i++) {
            baseDistMap.set(baseValues[i], DistributionService._splitsBuffer[i]);
        }
        // Attribute sub-atomic remainder of distribution to the most probable (peak) level
        const peakLevel = xp + N;
        ProbUtils.addItemMass(baseDistMap, peakLevel, baseRemainder);

        // 2. Random multiplier bonus distribution (Triangular Centered)
        const finalDist: { [modVal: number]: bigint } = {};
        const steps = ENGINE_DEFAULTS.RNG_STEPS_FOR_DISTRIBUTION;
        const triWeights = this.getTriangularWeights(steps);
        const totalTriWeight = BigInt(steps * steps);

        const halfRange = rngRange; 
        const unitStep = halfRange / (steps - 1);

        for (const [base, bProb] of baseDistMap.entries()) {
            const modRemainder = ProbUtils.distributeDetailed(bProb, triWeights, totalTriWeight, DistributionService._splitsBuffer);
            
            for (let k = 0; k < triWeights.length; k++) {
                const bonus = (k * unitStep) - halfRange;
                const modVal = Math.max(1, ProbUtils.mcRound(base * (1 + bonus)));
                finalDist[modVal] = (finalDist[modVal] || 0n) + DistributionService._splitsBuffer[k];
            }
            // Attribute remainder of this sub-distribution to the central (unmodified) peak
            const centralModVal = Math.max(1, ProbUtils.mcRound(base));
            finalDist[centralModVal] = (finalDist[centralModVal] || 0n) + modRemainder;
        }

        if (cache) cache.setDist(version, key, finalDist);
        return finalDist;
    }

    /** Helper for generating triangular probability weights. */
    private static getTriangularWeights(N: number): bigint[] {
        const weights: bigint[] = [];
        const count = 2 * N - 1;
        for (let k = 0; k < count; k++) {
            weights.push(BigInt(k < N ? (k + 1) : (count - k)));
        }
        return weights;
    }
}
