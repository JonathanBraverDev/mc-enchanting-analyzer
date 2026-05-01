import { ForwardingContext, PackedCombo, PackedEnchant, ExpansionBlueprint } from '#types/index.js';
import { ComboUtils, ProbUtils } from '#utils/index.js';
import { ENGINE_LIMITS, BIGINT_CONSTANTS } from '#constants/engine.js';
import { DistributionBufferPool } from '#engine/distribution/DistributionBufferPool.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';

/**
 * Low-level primitives for the enchantment search engine.
 */
export class SearchProcessor {
    /**
     * No-op timing shim retained for API compatibility with SearchStateTracker.
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
        countMass: BigUint64Array
    ): bigint {
        if (isBook && currentCount > 1) {
            const { rem } = this.redistributeBookProb(packedChosen, currentEnchants, prob, currentCount, results, countMass);
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
        countMass: BigUint64Array
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
        tracker: SearchStateTracker
    ): void {
        const { registry, queue, pool, poolWeights, initialTotalWeight } = ctx;

        const buffer = DistributionBufferPool.getBuffer(0);
        const splitRemainder = ProbUtils.distributeDetailed(currentProb, poolWeights, initialTotalWeight, buffer);
        tracker.record('sieved', splitRemainder);

        for (const [i, e] of pool.entries()) {
            const pNext = buffer[i];
            if (pNext === undefined || pNext === 0n) continue;

            const nextId = ComboUtils.getEnchantId(e);
            const nextMeta = (BIGINT_CONSTANTS.ID_BIT_LOOKUP[nextId]! << BIGINT_CONSTANTS.ENCHANT_SHIFT) | BIGINT_CONSTANTS.LEVEL_LOOKUP[currentLevel]!;
            const nextPacked = ComboUtils.pack([e], registry.enchantToIndex) as PackedCombo;

            tracker.record('pending', pNext);
            queue.pushOrMerge(nextMeta, pNext, nextPacked);
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
        tracker: SearchStateTracker
    ): void {
        const { registry, cat, pool } = ctx;
        const { indexToEnchant } = registry;
        const currentBitset = currentMeta >> BIGINT_CONSTANTS.ENCHANT_SHIFT;
        const currentLevel = Number(currentMeta & BIGINT_CONSTANTS.RANK_MASK);
        const isBook = cat === "book";

        const currentEnchants = (isBook && currentCount > 1)
            ? ComboUtils.unpack(currentCombo, indexToEnchant)
            : [] as PackedEnchant[];

        // currentLevel only drives the probability of earning another enchant slot from this node.
        // Eligibility still comes from ctx.pool, which SearchService fixed from the initial full
        // modified level before the search started.
        const probContinue = (isBook && !registry.multiEnchantBooks && currentCount >= 1)
            ? 0n
            : (ProbUtils.PROB_CONTINUE_TABLE[currentLevel] || 0n);

        if (!tracker.has(currentMeta)) {
            const tempEligible: PackedEnchant[] = [];
            const tempWeights: number[] = [];
            let eligibleCount = 0;
            let totalWeight = 0;

            for (const [i, e] of pool.entries()) {
                const id = ComboUtils.getEnchantId(e);
                if ((currentBitset & BIGINT_CONSTANTS.ID_BIT_LOOKUP[id]!) !== 0n) continue;
                const conflictBitset = registry.conflictBitsets[id];
                if (conflictBitset !== undefined && (currentBitset & conflictBitset) !== 0n) continue;
                const weight = ctx.poolWeights[i];
                if (weight === undefined) continue;
                tempEligible.push(e);
                tempWeights.push(weight);
                eligibleCount++;
                totalWeight += weight;
            }

            // Minecraft halves the effective level between additional enchant rolls, but it does not
            // rebuild the eligible pool from that halved level. The pool stays frozen from the initial
            // full modified level; this nextLevel only feeds the continuation roll for the next slot.
            // currentCount >= 1 is always true here (count-0 nodes take the processInitialNode path),
            // so the real invariant is the halving sequence: 2nd enchant sees level/2, 3rd sees level/4, etc.
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
        }

        tracker.forwardMass(currentProb, currentMeta, currentCombo, ctx, SearchProcessor);
    }
}
