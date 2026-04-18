import { ForwardingContext, PackedCombo, PackedEnchant, ExpansionBlueprint } from '#types/index.js';
import { ComboUtils, ProbUtils } from '#utils/index.js';
import { ENGINE_LIMITS, BIGINT_CONSTANTS } from '#constants/engine.js';
import { DistributionPool } from '#engine/distribution/DistributionPool.js';
import { SearchManager } from '#engine/search/SearchManager.js';

/**
 * Low-level primitives for the enchantment search engine.
 */
export class SearchProcessor {
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
            const { rem } = this.redistributeBookProb(packedChosen, prob, currentCount, guaranteedFirstId, enchantToIndex, indexToEnchant, results, countMass, anyMass, rankMass);
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

        ComboUtils.forEach(packedChosen, currentCount, (idx) => {
            const e = indexToEnchant[idx] as PackedEnchant;
            if (e === undefined) return;

            const id = ComboUtils.getEnchantId(e);
            const isGuaranteed = guaranteedFirstId !== null && id === guaranteedFirstId;
            const nSurvivors = isGuaranteed ? nOutcomes : nOutcomes - 1;
            
            const survivorMass = ProbUtils.roundScale(prob, BigInt(nSurvivors), BigInt(nOutcomes));
            const loss = prob - survivorMass;
            if (loss > 0n) {
                ProbUtils.addItemMass(anyMass, id, -loss);
                ProbUtils.addItemMass(rankMass, e, -loss);
            }
        });

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
        const { registry, queue, guaranteedFirstId, pool, poolWeights, initialTotalWeight } = ctx;
        
        const splits = (() => {
            const buffer = DistributionPool.getBuffer(0);
            const splitRemainder = ProbUtils.distributeDetailed(currentProb, poolWeights, initialTotalWeight, buffer);
            tracker.record('sieved', splitRemainder);
            return buffer;
        })();

        for (const [i, e] of pool.entries()) {
            const pNext = splits[i];
            if (pNext === undefined || pNext === 0n) continue;
            
            const nextId = ComboUtils.getEnchantId(e);
            
            // Replaced BigInt allocations with precomputed lookups
            const nextMeta = ((BIGINT_CONSTANTS.ID_BIT_LOOKUP[nextId]!) << BIGINT_CONSTANTS.ENCHANT_SHIFT) | BIGINT_CONSTANTS.LEVEL_LOOKUP[currentLevel]!;
            const nextPacked = ComboUtils.pack([e], guaranteedFirstId, registry.enchantToIndex) as PackedCombo;

            ctx.anyMass[nextId]! += pNext;
            ctx.rankMass[e]! += pNext;

            tracker.record('pending', pNext);
            queue.pushOrMerge(nextMeta, pNext, currentLevel, nextPacked);
        }
    }

    private static readonly SCRATCH_ENCHANTS = new Int32Array(256);
    private static readonly SCRATCH_WEIGHTS = new Int32Array(256);

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
        const { registry, cat, pool } = ctx;
        const currentBitset = currentMeta >> BIGINT_CONSTANTS.ENCHANT_SHIFT;
        const currentLevel = Number(currentMeta & BIGINT_CONSTANTS.RANK_MASK);
        const isBook = cat === "book";

        let catCache = registry.expansionCache.get(cat);
        if (!catCache) {
            catCache = new Map();
            registry.expansionCache.set(cat, catCache);
        }

        if (!catCache.has(currentMeta)) {
            const poolLen = pool.length;
            const poolWeights = ctx.poolWeights;
            const conflictBitsets = registry.conflictBitsets;
            let eligibleCount = 0;
            let totalWeight = 0;

            for (let i = 0; i < poolLen; i++) {
                const e = pool[i]!;
                const id = ComboUtils.getEnchantId(e);
                const idBit = BIGINT_CONSTANTS.ID_BIT_LOOKUP[id]!;
                if ((currentBitset & idBit) !== 0n) continue;
                
                const conflictBitset = conflictBitsets[id];
                if (conflictBitset !== undefined && (currentBitset & conflictBitset) !== 0n) continue;
                
                const weight = poolWeights[i];
                if (weight === undefined) continue;
                
                SearchProcessor.SCRATCH_ENCHANTS[eligibleCount] = e;
                SearchProcessor.SCRATCH_WEIGHTS[eligibleCount] = weight;
                eligibleCount++;
                totalWeight += weight;
            }
            
            const probContinue = (isBook && !registry.multiEnchantBooks && currentCount >= 1)
                ? 0n
                : (ProbUtils.PROB_CONTINUE_TABLE[currentLevel] || 0n);

            const nextLevel = currentCount >= 1 ? Math.floor(currentLevel / 2) : currentLevel;
            const blueprint = new ExpansionBlueprint(
                probContinue,
                totalWeight,
                eligibleCount,
                Array.from(SearchProcessor.SCRATCH_ENCHANTS.subarray(0, eligibleCount)) as PackedEnchant[],
                new Int32Array(SearchProcessor.SCRATCH_WEIGHTS.subarray(0, eligibleCount)),
                nextLevel,
                currentCount,
                currentCombo
            );
            catCache.set(currentMeta, blueprint);
        }

        tracker.markVisited(currentMeta);
        tracker.forwardMass(currentProb, currentMeta, ctx, SearchProcessor);
    }
}
