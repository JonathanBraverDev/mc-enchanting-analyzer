import { RegistryState, ForwardingContext, PackedCombo, PackedEnchant, SearchTiming, ExpansionBlueprint } from '../types/index.js';
import { ComboUtils, ProbUtils, PRECISION } from '../utils/index.js';
import { ENGINE_LIMITS, SEARCH_CONSTANTS } from '../constants/engine.js';
import { DistributionPool } from './DistributionPool.js';
import { ProbabilityMassTracker } from './ProbabilityMassTracker.js';

/**
 * Low-level primitives for the enchantment search engine.
 */
export class SearchProcessor {
    /**
     * Executes a function and records its duration to the specified timing bucket.
     */
    public static withTiming<T>(timing: SearchTiming | undefined, bucket: keyof Omit<SearchTiming, 'totalMs'>, fn: () => T): T {
        if (!timing) return fn();
        const start = performance.now();
        const result = fn();
        timing[bucket] += performance.now() - start;
        return result;
    }

    /**
     * Reusable terminal check for mass distribution.
     * Returns true if expansion should stop (limit reached, threshold too low, or results map full).
     */
    public static isTerminalCondition(
        currentCount: number,
        isBook: boolean,
        probForward: bigint,
        resultsSize: number,
        resultsLimit: number,
        currentCombo: PackedCombo,
        hasCombo: boolean,
        multiEnchantBooks: boolean,
        floor: bigint
    ): { isLimitReached: boolean; isTooSmall: boolean; isMapFull: boolean; isTerminal: boolean } {
        const isLimitReached = currentCount >= (isBook && !multiEnchantBooks ? 1 : ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM);
        const isTooSmall = probForward < floor;
        const isMapFull = resultsSize >= resultsLimit && !hasCombo;
        
        return {
            isLimitReached,
            isTooSmall,
            isMapFull,
            isTerminal: isLimitReached || isTooSmall || isMapFull
        };
    }

    /** Settles `prob` into results/countMass, via book redistribution when applicable, and returns rem. */
    public static settleMass(
        registry: RegistryState,
        isBook: boolean,
        currentCount: number,
        packedChosen: PackedCombo,
        currentEnchants: PackedEnchant[],
        prob: bigint,
        guaranteedFirstId: number | null,
        enchantToIndex: Map<number, number>,
        indexToEnchant: number[],
        results: Map<PackedCombo, bigint>,
        countMass: BigUint64Array,
        anyMass: BigUint64Array,
        rankMass: BigUint64Array
    ): bigint {
        if (isBook && currentCount > 1) {
            const { rem } = this.redistributeBookProb(packedChosen, currentEnchants, prob, currentCount, guaranteedFirstId, enchantToIndex, indexToEnchant, results, countMass, anyMass, rankMass);
            return rem;
        } else {
            ProbUtils.addItemMass(results, packedChosen, prob);
            ProbUtils.addItemMass(countMass, currentCount, prob);
            return 0n;
        }
    }

    /**
     * Core of book redistribution: calls removeAdditional, splits `prob` equally across all N→(N-1)
     * outcomes, writes each chunk to `results`, updates `countMass`, corrects `anyMass`/`rankMass`.
     */
    public static redistributeBookProb(
        packedChosen: PackedCombo,
        originalEnchants: PackedEnchant[],
        prob: bigint,
        currentCount: number,
        guaranteedFirstId: number | null,
        _enchantToIndex: Map<number, number>,
        indexToEnchant: number[],
        results: Map<PackedCombo, bigint>,
        countMass: BigUint64Array,
        anyMass: BigUint64Array,
        rankMass: BigUint64Array
    ): { rem: bigint } {
        const redistributed = ComboUtils.removeAdditional(packedChosen, guaranteedFirstId, indexToEnchant) as PackedCombo[];
        const nOutcomes = redistributed.length;
        
        let quotient = 0n;
        let splitRemainder = prob;
        if (nOutcomes > 0) {
            const bigN = BigInt(nOutcomes);
            quotient = prob / bigN;
            splitRemainder = prob % bigN;
        }

        for (let i = 0; i < nOutcomes; i++) {
            ProbUtils.addItemMass(results, redistributed[i], quotient);
        }
        if (nOutcomes > 0 && splitRemainder > 0n) {
            ProbUtils.addItemMass(results, redistributed[0], splitRemainder);
        }

        const finalCount = currentCount - 1;
        ProbUtils.addItemMass(countMass, finalCount, prob);

        for (const e of originalEnchants) {
            const id = ComboUtils.getEnchantId(e);
            const isGuaranteed = guaranteedFirstId !== null && id === guaranteedFirstId;
            const nSurvivors = isGuaranteed ? nOutcomes : nOutcomes - 1;
            
            const survivorMass = ProbUtils.roundScale(prob, BigInt(nSurvivors), BigInt(nOutcomes));
            const loss = prob - survivorMass;
            if (loss > 0n) {
                ProbUtils.addItemMass(anyMass, id, -loss);
                ProbUtils.addItemMass(rankMass, e, -loss);
            }
        }

        return { rem: 0n };
    }

    public static processInitialNode(
        currentProb: bigint,
        currentMeta: bigint,
        currentLevel: number,
        ctx: ForwardingContext,
        tracker: ProbabilityMassTracker
    ): void {
        const { registry, timing, queue, guaranteedFirstId, pool, poolWeights, initialTotalWeight } = ctx;
        
        const splits = this.withTiming(timing, 'distributionMs', () => {
            const buffer = DistributionPool.getBuffer(0);
            const splitRemainder = ProbUtils.distributeDetailed(currentProb, poolWeights, initialTotalWeight, buffer);
            tracker.record('sieved', splitRemainder);
            return buffer;
        });

        this.withTiming(timing, 'heapMs', () => {
            for (let i = 0; i < pool.length; i++) {
                const pNext = splits[i];
                if (pNext === 0n) continue;
                
                const nextId = ComboUtils.getEnchantId(pool[i]);
                const nextMeta = ((1n << BigInt(nextId)) << 8n) | BigInt(currentLevel);
                const nextPacked = ComboUtils.pack([pool[i]], guaranteedFirstId, registry.enchantToIndex) as PackedCombo;

                ProbUtils.addItemMass(ctx.anyMass, nextId, pNext);
                ProbUtils.addItemMass(ctx.rankMass, pool[i], pNext);

                tracker.record('pending', pNext);
                queue.pushOrMerge(nextMeta, pNext, currentLevel, nextPacked);
            }
        });
    }

    public static processSearchNode(
        currentProb: bigint,
        currentMeta: bigint,
        currentCombo: PackedCombo,
        currentCount: number,
        ctx: ForwardingContext,
        tracker: ProbabilityMassTracker
    ): void {
        const { registry, timing, cat, pool } = ctx;
        const { indexToEnchant } = registry;
        const currentBitset = currentMeta >> 8n;
        const currentLevel = Number(currentMeta & 0xFFn);
        const isBook = cat === "book";

        const currentEnchants = (isBook && currentCount > 1)
            ? ComboUtils.unpack(currentCombo, indexToEnchant)
            : [] as PackedEnchant[];

        const probContinue = (isBook && !registry.multiEnchantBooks && currentCount >= 1)
            ? 0n
            : (SEARCH_CONSTANTS.PROB_CONTINUE_TABLE[currentLevel] || 0n);

        if (!tracker.has(currentMeta)) {
            this.withTiming(timing, 'filteringMs', () => {
                const tempEligible: PackedEnchant[] = [];
                const tempWeights: number[] = [];
                let eligibleCount = 0;
                let totalWeight = 0;

                for (let i = 0; i < pool.length; i++) {
                    const e = pool[i];
                    const id = ComboUtils.getEnchantId(e);
                    if ((currentBitset & (1n << BigInt(id))) !== 0n) continue;
                    if ((currentBitset & registry.conflictBitsets[id]) !== 0n) continue;
                    tempEligible.push(e);
                    tempWeights.push(ctx.poolWeights[i]);
                    eligibleCount++;
                    totalWeight += ctx.poolWeights[i];
                }
                
                const nextLevel = currentCount >= 1 ? Math.floor(currentLevel / 2) : currentLevel;
                const blueprint: ExpansionBlueprint = {
                    probContinue,
                    totalWeight,
                    eligibleCount,
                    eligibleEnchants: tempEligible,
                    eligibleWeights: new Int32Array(tempWeights),
                    nextLevel,
                    currentCount,
                    currentCombo,
                    currentEnchants,
                    residue: 0n
                };
                tracker.registerExpansion(currentMeta, blueprint);
            });
        }

        tracker.forwardMass(currentProb, currentMeta, currentCombo, ctx, SearchProcessor);
    }
}
