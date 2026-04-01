import { PRECISION } from '../utils/index.js';
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
        
        const baseDist: { [val: number]: bigint } = {};
        const nBig = BigInt(N);
        const nSq = nBig * nBig;
        
        // Sum of two discrete uniforms U[0, N-1] is a triangular distribution
        for (let k = 0; k <= 2 * N - 2; k++) {
            const val = xp + k + 1;
            const count = k < N ? (k + 1) : (2 * N - 1 - k);
            // Parity Note: Division before multiplication replicates the truncation error of the original nested loops
            baseDist[val] = (baseDist[val] || 0n) + (PRECISION / nSq) * BigInt(count);
        }

        const finalDist: { [modVal: number]: bigint } = {};
        const steps = ENGINE_DEFAULTS.RNG_STEPS_FOR_DISTRIBUTION;
        const totalTriSteps = 2 * steps - 1;
        const triSq = BigInt(steps * steps);
        
        for (let [baseStr, bProb] of Object.entries(baseDist)) {
            const base = Number(baseStr);
            // Sum of two continuous uniforms U[0, rngRange] is a triangular distribution on [0, 2*rngRange]
            // We shift it by -rngRange to get a centered triangular distribution on [-rngRange, rngRange]
            const halfRange = rngRange; 
            const unitStep = halfRange / (steps - 1);

            for (let k = 0; k < totalTriSteps; k++) {
                const bonus = (k * unitStep) - halfRange;
                const count = k < steps ? (k + 1) : (totalTriSteps - k);
                const modVal = Math.max(1, Math.floor(base * (1 + bonus) + 0.5));
                // Parity Note: Same division-first pattern for bit-identical results
                finalDist[modVal] = (finalDist[modVal] || 0n) + (bProb / triSq) * BigInt(count);
            }
        }

        cache?.set(key, finalDist);
        return finalDist;
    }
}
