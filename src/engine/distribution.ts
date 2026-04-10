import { PRECISION, ProbUtils } from '../utils/index.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { RegistryState } from '../types/index.js';

/**
 * Service for calculating the probability distribution of Modified Levels.
 */
export class DistributionService {
    /**
     * Calculates the probability distribution of Modified Levels.
     */
    public static getModifiedLevelDist(xp: number, enchantability: number, registry: RegistryState, cache?: Map<string, { [level: number]: bigint }>): { [level: number]: bigint } {
        const mech = registry.mechanics;
        const key = `${xp}@${enchantability}@${mech.enchantability_bonus_divisor}@${mech.random_bonus_range}`;
        if (cache?.has(key)) return cache.get(key)!;

        // 1.0 in BigInt fixed-point
        if (enchantability <= 0) return { [xp]: PRECISION };
        
        const div = mech.enchantability_bonus_divisor ?? 4;
        const rngRange = mech.random_bonus_range ?? 0.15;

        const N = Math.floor(enchantability / div) + 1;
        
        // 1. Base enchantability bonus distribution (Triangular U[0, N-1] + U[0, N-1])
        const baseValues: number[] = [];
        const baseWeights: bigint[] = [];
        for (let k = 0; k <= 2 * N - 2; k++) {
            baseValues.push(xp + k + 1);
            baseWeights.push(BigInt(k < N ? (k + 1) : (2 * N - 1 - k)));
        }
        const totalBaseWeight = BigInt(N * N);
        const { parts: baseParts, remainder: baseRemainder } = ProbUtils.distributeDetailed(PRECISION, baseWeights, totalBaseWeight);
        
        const baseDistMap = new Map<number, bigint>();
        for (let i = 0; i < baseValues.length; i++) {
            baseDistMap.set(baseValues[i], baseParts[i]);
        }
        // Attribute sub-atomic remainder of distribution to the most probable (peak) level
        const peakLevel = xp + N;
        baseDistMap.set(peakLevel, (baseDistMap.get(peakLevel) || 0n) + baseRemainder);

        // 2. Random multiplier bonus distribution (Triangular Centered)
        const finalDist: { [modVal: number]: bigint } = {};
        const steps = ENGINE_DEFAULTS.RNG_STEPS_FOR_DISTRIBUTION;
        const totalTriSteps = 2 * steps - 1;
        const triWeights: bigint[] = [];
        for (let k = 0; k < totalTriSteps; k++) {
            triWeights.push(BigInt(k < steps ? (k + 1) : (totalTriSteps - k)));
        }
        const totalTriWeight = BigInt(steps * steps);

        const halfRange = rngRange; 
        const unitStep = halfRange / (steps - 1);

        for (const [base, bProb] of baseDistMap.entries()) {
            const { parts: modParts, remainder: modRemainder } = ProbUtils.distributeDetailed(bProb, triWeights, totalTriWeight);
            
            for (let k = 0; k < totalTriSteps; k++) {
                const bonus = (k * unitStep) - halfRange;
                const modVal = Math.max(1, Math.floor(base * (1 + bonus) + 0.5));
                finalDist[modVal] = (finalDist[modVal] || 0n) + modParts[k];
            }
            // Attribute remainder of this sub-distribution to the central (unmodified) peak
            const centralModVal = Math.max(1, Math.floor(base + 0.5));
            finalDist[centralModVal] = (finalDist[centralModVal] || 0n) + modRemainder;
        }

        cache?.set(key, finalDist);
        return finalDist;
    }
}
