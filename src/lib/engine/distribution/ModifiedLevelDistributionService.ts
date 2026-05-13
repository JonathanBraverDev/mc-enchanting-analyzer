import { PRECISION, ProbUtils } from '#utils/index.js';
import { ENGINE_LIMITS, MATH_CONSTANTS } from '#constants/engine.js';
import { MINECRAFT_RULES } from '#constants/minecraft.js';
import { RegistryState, LevelDistribution, EngineInstrumentation } from '#types/index.js';
import { CacheManager } from '#engine/cache/CacheManager.js';

const toLevelDistribution = (entries: Iterable<readonly [number, bigint]>): LevelDistribution => {
    return Object.fromEntries(entries) as LevelDistribution;
};

const addLevelMass = (target: Map<number, bigint>, level: number, mass: bigint): void => {
    if (!Number.isSafeInteger(level) || level < 0) {
        throw new RangeError(`Modified level ${level} is not a valid distribution bucket`);
    }

    target.set(level, (target.get(level) || 0n) + mass);
};

/**
 * Service for calculating the probability distribution of Modified Levels.
 * Modularized for testability and thread-safety.
 */
export class ModifiedLevelDistributionService {
    private readonly buffer: BigUint64Array;

    constructor(bufferSize: number = ENGINE_LIMITS.DEFAULT_BUFFER_SIZE) {
        this.buffer = new BigUint64Array(bufferSize);
    }

    /**
     * Calculates the probability distribution of Modified Levels for a given XP and enchantability.
     */
    public getModifiedLevelDist(
        registry: RegistryState,
        xp: number,
        enchantability: number,
        cache?: CacheManager,
        instrumentation?: EngineInstrumentation
    ): LevelDistribution {
        const mech = registry.mechanics;
        const key = this.createCacheKey(xp, enchantability, mech);

        if (cache) {
            const cached = cache.getDist(registry.version, key);
            if (cached) return cached;
        }

        // 1.0 in BigInt fixed-point
        if (enchantability <= 0) return toLevelDistribution([[xp, PRECISION]]);

        const div = mech.enchantability_bonus_divisor ?? MINECRAFT_RULES.ENCHANTABILITY_DIVISOR_MODERN;
        const rngRange = mech.random_bonus_range ?? MINECRAFT_RULES.RANDOM_BONUS_RANGE;
        const N = Math.floor(enchantability / div) + 1;

        // Ensure buffer is large enough for N or RNG_STEPS
        const requiredSize = Math.max(2 * N, MATH_CONSTANTS.RNG_STEPS_FOR_DISTRIBUTION);
        if (this.buffer.length < requiredSize) {
            throw new Error(`Distribution buffer size ${this.buffer.length} is too small for required ${requiredSize}`);
        }

        // 1. Base enchantability bonus distribution
        const baseDistMap = this.computeBaseDistribution(xp, N);

        // 2. Random multiplier bonus distribution
        const finalDist = this.applyRandomMultiplier(baseDistMap, rngRange);

        if (cache) {
            cache.setDist(registry.version, key, finalDist);
        }

        if (instrumentation) {
            instrumentation.distCache = cache ? cache.getEngineMetrics().distCache : { hits: 0, misses: 0 };
        }

        return finalDist;
    }

    private createCacheKey(xp: number, enchantability: number, mech: any): string {
        return `${xp}@${enchantability}@${mech.enchantability_bonus_divisor}@${mech.random_bonus_range}`;
    }

    private computeBaseDistribution(xp: number, N: number): Map<number, bigint> {
        const baseValues: number[] = [];
        for (let k = 0; k <= 2 * N - 2; k++) baseValues.push(xp + k + 1);

        const baseWeights = this.getTriangularWeights(N);
        const totalBaseWeight = BigInt(N * N);
        const baseRemainder = ProbUtils.distributeDetailed(PRECISION, baseWeights, totalBaseWeight, this.buffer);

        const baseDistMap = new Map<number, bigint>();
        for (const [i, base] of baseValues.entries()) {
            const bufVal = this.buffer[i];
            if (bufVal !== undefined) baseDistMap.set(base, bufVal);
        }

        // Attribute sub-atomic remainder to the peak level
        const peakLevel = xp + N;
        ProbUtils.addItemMass(baseDistMap, peakLevel, baseRemainder);

        return baseDistMap;
    }

    private applyRandomMultiplier(baseDistMap: Map<number, bigint>, rngRange: number): LevelDistribution {
        const finalDist = new Map<number, bigint>();
        const steps = MATH_CONSTANTS.RNG_STEPS_FOR_DISTRIBUTION;
        const triWeights = this.getTriangularWeights(steps);
        const totalTriWeight = BigInt(steps * steps);

        const halfRange = rngRange;
        const unitStep = halfRange / (steps - 1);

        for (const [base, bProb] of baseDistMap.entries()) {
            const modRemainder = ProbUtils.distributeDetailed(bProb, triWeights, totalTriWeight, this.buffer);

            for (let k = 0; k < triWeights.length; k++) {
                const bonus = (k * unitStep) - halfRange;
                const modVal = Math.max(1, ProbUtils.mcRound(base * (1 + bonus)));
                const bufVal = this.buffer[k];
                if (bufVal === undefined) continue;
                addLevelMass(finalDist, modVal, bufVal);
            }

            // Attribute remainder to the central peak
            const centralModVal = Math.max(1, ProbUtils.mcRound(base));
            addLevelMass(finalDist, centralModVal, modRemainder);
        }

        return toLevelDistribution(finalDist);
    }

    private getTriangularWeights(N: number): bigint[] {
        const weights: bigint[] = [];
        const count = 2 * N - 1;
        for (let k = 0; k < count; k++) {
            weights.push(BigInt(k < N ? (k + 1) : (count - k)));
        }
        return weights;
    }
}
