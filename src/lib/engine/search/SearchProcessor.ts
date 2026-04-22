import { ForwardingContext, PackedCombo, PackedEnchant, ExpansionBlueprint } from '#types/index.js';
import { ComboUtils, ProbUtils } from '#utils/index.js';
import { ENGINE_LIMITS, SEARCH_CONSTANTS } from '#constants/engine.js';
import { DistributionPool } from '#engine/distribution/DistributionPool.js';
import { SearchManager } from '#engine/search/SearchManager.js';

/**
 * Low-level primitives for the enchantment search engine.
 */
export class SearchProcessor {
    /**
     * No-op timing shim retained for API compatibility with SearchManager.
     * Fine-grained per-subsystem timing has been removed; only aggregate totalMs
     * and searchMs are tracked. Callers that still reference this method compile
     * without changes while the overhead is eliminated.
     */
    public static withTiming<T>(_timing: any, _bucket: string, fn: () => T): T {
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
        results: Map<PackedCombo, bigint>,
        countMass: BigUint64Array,
        anyMass: BigUint64Array,
        rankMass: BigUint64Array
    ): bigint {
        if (isBook && currentCount > 1) {
            const { rem } = this.redistributeBookProb(packedChosen, currentEnchants, prob, currentCount, results, countMass, anyMass, rankMass);
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
        results: Map<PackedCombo, bigint>,
        countMass: BigUint64Array,
        anyMass: BigUint64Array,
        rankMass: BigUint64Array
    ): { rem: bigint } {
        const redistributed = ComboUtils.removeAdditional(packedChosen) as PackedCombo[]; 
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

        const survivorMass = ProbUtils.roundScale(prob, BigInt(nOutcomes - 1), BigInt(nOutcomes));
        const lossPerEnchant = prob - survivorMass;

        for (const e of originalEnchants) {
            const id = ComboUtils.getEnchantId(e);
            if (lossPerEnchant > 0n) {
                ProbUtils.addItemMass(anyMass, id, -lossPerEnchant);
                ProbUtils.addItemMass(rankMass, e, -lossPerEnchant);
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
        const { registry, timing, queue, pool, poolWeights, initialTotalWeight } = ctx;
        
        const splits = this.withTiming(timing, 'distributionMs', () => {
            const buffer = DistributionPool.getBuffer(0);
            const splitRemainder = ProbUtils.distributeDetailed(currentProb, poolWeights, initialTotalWeight, buffer);
            tracker.record('sieved', splitRemainder);
            return buffer;
        });

        this.withTiming(timing, 'heapMs', () => {
            for (const [i, e] of pool.entries()) {
                const pNext = splits[i];
                if (pNext === undefined || pNext === 0n) continue;
                
                const nextId = ComboUtils.getEnchantId(e);
                const nextMeta = ((1n << BigInt(nextId)) << 8n) | BigInt(currentLevel);
                const nextPacked = ComboUtils.pack([e], registry.enchantToIndex) as PackedCombo;

                ProbUtils.addItemMass(ctx.anyMass, nextId, pNext);
                ProbUtils.addItemMass(ctx.rankMass, e, pNext);

                tracker.record('pending', pNext);
                queue.pushOrMerge(nextMeta, pNext, currentLevel, nextPacked);
            }
        });
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

                for (const [i, e] of pool.entries()) {
                    const id = ComboUtils.getEnchantId(e);
                    if ((currentBitset & (1n << BigInt(id))) !== 0n) continue;
                    const conflictBitset = registry.conflictBitsets[id];
                    if (conflictBitset !== undefined && (currentBitset & conflictBitset) !== 0n) continue;
                    const weight = ctx.poolWeights[i];
                    if (weight === undefined) continue;
                    tempEligible.push(e);
                    tempWeights.push(weight);
                    eligibleCount++;
                    totalWeight += weight;
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
