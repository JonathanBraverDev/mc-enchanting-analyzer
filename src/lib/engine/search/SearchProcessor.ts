import { ForwardingContext, PackedCombo, PackedEnchant, SearchTiming, ExpansionBlueprint } from '#types/index.js';
import { ComboUtils, ProbUtils } from '#utils/index.js';
import { ENGINE_LIMITS, PACKING_CONSTANTS } from '#constants/engine.js';
import { DistributionPool } from '#engine/distribution/DistributionPool.js';
import { SearchManager } from '#engine/search/SearchManager.js';

/**
 * Low-level primitives for the enchantment search engine.
 */
export class SearchProcessor {
    /**
     * Executes a function and records its duration to the specified timing bucket.
     * Used for detailed performance instrumentation of specific engine subsystems.
     */
    public static withTiming<T>(timing: SearchTiming | undefined, bucket: keyof Omit<SearchTiming, 'totalMs'>, fn: () => T): T {
        if (timing) {
            const start = performance.now();
            const result = fn();
            timing[bucket] += performance.now() - start;
            return result;
        }
        return fn();
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
        hasCombo: boolean,
        multiEnchantBooks: boolean,
        floor: bigint,
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

        for (const combo of redistributed) {
            ProbUtils.addItemMass(results, combo, quotient);
        }
        const firstRedistributed = redistributed[0];
        if (nOutcomes > 0 && splitRemainder > 0n && firstRedistributed !== undefined) {
            ProbUtils.addItemMass(results, firstRedistributed, splitRemainder);
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

    /**
     * Entry point for a search: distributes mass from the "initial mass" (empty item)
     * across the first layer of possible enchantments.
     */
    public static processInitialNode(
        currentProb: bigint,
        currentLevel: number,
        ctx: ForwardingContext,
        tracker: SearchManager
    ): void {
        const { registry, timing, queue, guaranteedFirstId, pool, poolWeights, initialTotalWeight } = ctx;
        
        const splits = timing ? (() => {
            const start = performance.now();
            const buffer = DistributionPool.getBuffer(0);
            const splitRemainder = ProbUtils.distributeDetailed(currentProb, poolWeights, initialTotalWeight, buffer);
            tracker.record('sieved', splitRemainder);
            timing.distributionMs += performance.now() - start;
            return buffer;
        })() : (() => {
            const buffer = DistributionPool.getBuffer(0);
            const splitRemainder = ProbUtils.distributeDetailed(currentProb, poolWeights, initialTotalWeight, buffer);
            tracker.record('sieved', splitRemainder);
            return buffer;
        })();

        if (timing) {
            const start = performance.now();
            for (const [i, e] of pool.entries()) {
                const pNext = splits[i];
                if (pNext === undefined || pNext === 0n) continue;
                
                const nextId = ComboUtils.getEnchantId(e);
                const nextMeta = ((1n << BigInt(nextId)) << BigInt(PACKING_CONSTANTS.ENCHANT_SHIFT)) | BigInt(currentLevel);
                const nextPacked = ComboUtils.pack([e], guaranteedFirstId, registry.enchantToIndex) as PackedCombo;

                ctx.anyMass[nextId]! += pNext;
                ctx.rankMass[e]! += pNext;

                tracker.record('pending', pNext);
                queue.pushOrMerge(nextMeta, pNext, currentLevel, nextPacked);
            }
            timing.heapMs += performance.now() - start;
        } else {
            for (const [i, e] of pool.entries()) {
                const pNext = splits[i];
                if (pNext === undefined || pNext === 0n) continue;
                
                const nextId = ComboUtils.getEnchantId(e);
                const nextMeta = ((1n << BigInt(nextId)) << BigInt(PACKING_CONSTANTS.ENCHANT_SHIFT)) | BigInt(currentLevel);
                const nextPacked = ComboUtils.pack([e], guaranteedFirstId, registry.enchantToIndex) as PackedCombo;

                ctx.anyMass[nextId]! += pNext;
                ctx.rankMass[e]! += pNext;

                tracker.record('pending', pNext);
                queue.pushOrMerge(nextMeta, pNext, currentLevel, nextPacked);
            }
        }
    }

    /**
     * Core expansion logic: determines eligibility for further enchantments,
     * calculates continuous distribution probabilities, and forwards mass to children.
     */
    public static processSearchNode(
        currentProb: bigint,
        currentMeta: bigint,
        currentCombo: PackedCombo,
        currentCount: number,
        ctx: ForwardingContext,
        tracker: SearchManager
    ): void {
        const { registry, timing, cat, pool } = ctx;
        const { indexToEnchant } = registry;
        const currentBitset = currentMeta >> BigInt(PACKING_CONSTANTS.ENCHANT_SHIFT);
        const currentLevel = Number(currentMeta & BigInt(PACKING_CONSTANTS.RANK_MASK));
        const isBook = cat === "book";

        const currentEnchants = (isBook && currentCount > 1)
            ? ComboUtils.unpack(currentCombo, indexToEnchant)
            : [] as PackedEnchant[];

        const probContinue = (isBook && !registry.multiEnchantBooks && currentCount >= 1)
            ? 0n
            : (ProbUtils.PROB_CONTINUE_TABLE[currentLevel] || 0n);

        if (!tracker.has(currentMeta)) {
            const filterFn = () => {
                const tempEligible: PackedEnchant[] = [];
                const tempWeights: number[] = [];
                let eligibleCount = 0;
                let totalWeight = 0;

                const poolLen = pool.length;
                const poolWeights = ctx.poolWeights;
                const conflictBitsets = registry.conflictBitsets;

                for (let i = 0; i < poolLen; i++) {
                    const e = pool[i]!;
                    const id = ComboUtils.getEnchantId(e);
                    const idBit = 1n << BigInt(id);
                    if ((currentBitset & idBit) !== 0n) continue;
                    
                    const conflictBitset = conflictBitsets[id];
                    if (conflictBitset !== undefined && (currentBitset & conflictBitset) !== 0n) continue;
                    
                    const weight = poolWeights[i];
                    if (weight === undefined) continue;
                    tempEligible.push(e);
                    tempWeights.push(weight);
                    eligibleCount++;
                    totalWeight += weight;
                }
                
                const nextLevel = currentCount >= 1 ? Math.floor(currentLevel / 2) : currentLevel;
                const blueprint = new ExpansionBlueprint(
                    probContinue,
                    totalWeight,
                    eligibleCount,
                    tempEligible,
                    new Int32Array(tempWeights),
                    nextLevel,
                    currentCount,
                    currentCombo,
                    currentEnchants
                );
                tracker.registerExpansion(currentMeta, blueprint);
            };

            if (timing) {
                const start = performance.now();
                filterFn();
                timing.filteringMs += performance.now() - start;
            } else {
                filterFn();
            }
        }

        tracker.forwardMass(currentProb, currentMeta, ctx, SearchProcessor);
    }
}
