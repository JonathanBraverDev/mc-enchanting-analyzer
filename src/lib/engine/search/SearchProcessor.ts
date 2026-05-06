import { ForwardingContext, PackedCombo, ExpansionBlueprint, PackedEnchant } from '#types/index.js';
import { ComboUtils, ProbUtils } from '#utils/index.js';
import { ENGINE_LIMITS, BIGINT_CONSTANTS } from '#constants/engine.js';
import { DistributionBufferPool } from '#engine/distribution/DistributionBufferPool.js';
import { SearchNodeGraph } from '#engine/search/SearchNodeGraph.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { ClueSearchPolicy } from '#engine/search/ClueSearchPolicy.js';

export interface SettlementMassResult {
    rounding: bigint;
    discarded: bigint;
}

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
        results: Map<PackedCombo, bigint>,
        cluePolicy?: ClueSearchPolicy | undefined,
        indexToEnchant?: readonly number[] | undefined
    ): SettlementMassResult {
        if (isBook && currentCount > 1) {
            return this.redistributeBookProb(packedChosen, prob, results, cluePolicy, indexToEnchant);
        } else {
            if (cluePolicy && indexToEnchant && !cluePolicy.containsTargetClue(packedChosen, indexToEnchant)) {
                return { rounding: 0n, discarded: prob };
            }
            ProbUtils.addItemMass(results, packedChosen, prob);
            return { rounding: 0n, discarded: 0n };
        }
    }

    /**
     * Core of book redistribution: calls removeAdditional, splits `prob` equally across all N→(N-1)
     * outcomes, writes each chunk to `results`, updates `countMass`, corrects `anyMass`/`rankMass`.
     */
    public static redistributeBookProb(
        packedChosen: PackedCombo,
        prob: bigint,
        results: Map<PackedCombo, bigint>,
        cluePolicy?: ClueSearchPolicy | undefined,
        indexToEnchant?: readonly number[] | undefined
    ): SettlementMassResult {
        const redistributed = ComboUtils.removeAdditional(packedChosen) as PackedCombo[];
        const nOutcomes = redistributed.length;

        let quotient = 0n;
        let splitRemainder = prob;
        if (nOutcomes > 0) {
            const bigN = BigInt(nOutcomes);
            quotient = prob / bigN;
            splitRemainder = prob % bigN;
        }

        if (nOutcomes === 0) {
            return { rounding: prob, discarded: 0n };
        }

        let discarded = 0n;
        for (let i = 0; i < redistributed.length; i++) {
            const combo = redistributed[i]!;
            const share = quotient + (i === 0 ? splitRemainder : 0n);
            if (cluePolicy && indexToEnchant && !cluePolicy.containsTargetClue(combo, indexToEnchant)) {
                discarded += share;
                continue;
            }
            ProbUtils.addItemMass(results, combo, share);
        }

        return { rounding: 0n, discarded };
    }

    /**
     * Entry point for a search: distributes mass from the "initial mass" (empty item)
     * across the first layer of possible enchantments.
     */
    public static processInitialNode(
        currentProb: bigint,
        _currentLevel: number,
        ctx: ForwardingContext,
        tracker: SearchStateTracker
    ): void {
        const { queue, graph, poolPlan } = ctx;
        const cluePolicy = ctx.cluePolicy;

        const buffer = DistributionBufferPool.getBuffer(0);
        const splitRemainder = ProbUtils.distributeDetailed(currentProb, poolPlan.weights, poolPlan.initialTotalWeight, buffer, poolPlan.length);
        tracker.mass.record('sieved', splitRemainder);

        for (let i = 0; i < poolPlan.length; i++) {
            const pNext = buffer[i];
            if (pNext === undefined || pNext === 0n) continue;

            const nextPacked = poolPlan.singleCombos[i]! as PackedCombo;
            if (cluePolicy && !cluePolicy.canSelectChild(poolPlan.pool[i]! as PackedEnchant, false)) {
                tracker.mass.record('clueIncompatible', pNext);
                continue;
            }
            const nodeId = poolPlan.identityMode === 'number53'
                ? graph.getOrCreateNumericNode(poolPlan.idMaskLo[i]!, poolPlan.idMaskHi[i]!, poolPlan.initialLevel, nextPacked, 1)
                : graph.getOrCreateBigIntNode(poolPlan.initialMetas[i]!, nextPacked, 1);

            tracker.mass.record('pending', pNext);
            queue.pushOrMerge(nodeId, pNext);
        }
    }

    /**
     * Builds the cached structural expansion data for a non-initial search node.
     */
    public static buildExpansionBlueprint(
        nodeId: number,
        ctx: ForwardingContext
    ): ExpansionBlueprint {
        const { registry, cat, poolPlan } = ctx;
        const currentCombo = ctx.graph.getCombo(nodeId);
        const currentCount = ctx.graph.getCount(nodeId);
        const currentLevel = ctx.graph.getLevel(nodeId);
        const isBook = cat === "book";
        const cluePolicy = ctx.cluePolicy;
        const targetAlreadySelected = cluePolicy?.containsTargetClue(currentCombo, registry.indexToEnchant) ?? false;

        // currentLevel only drives the probability of earning another enchant slot from this node.
        // Eligibility still comes from ctx.pool, which SearchService fixed from the initial full
        // modified level before the search started.
        const probContinue = (isBook && !registry.multiEnchantBooks && currentCount >= 1)
            ? 0n
            : (ProbUtils.PROB_CONTINUE_TABLE[currentLevel] || 0n);

        let eligibleCount = 0;
        let totalWeight = 0;

        const nextLevel = currentCount >= 1 ? Math.floor(currentLevel / 2) : currentLevel;
        const nextLevelBits = BIGINT_CONSTANTS.LEVEL_LOOKUP[nextLevel]!;
        const edgeStart = ctx.graph.beginEdgeSpan();

        if (poolPlan.identityMode === 'number53' && ctx.graph.isNumericNode(nodeId)) {
            const currentMaskLo = ctx.graph.getMaskLo(nodeId);
            const currentMaskHi = ctx.graph.getMaskHi(nodeId);

            for (let i = 0; i < poolPlan.length; i++) {
                const idMaskLo = poolPlan.idMaskLo[i]!;
                const idMaskHi = poolPlan.idMaskHi[i]!;
                if ((currentMaskLo & idMaskLo) !== 0 || (currentMaskHi & idMaskHi) !== 0) continue;
                const conflictMaskLo = poolPlan.conflictMaskLo[i]!;
                const conflictMaskHi = poolPlan.conflictMaskHi[i]!;
                if ((currentMaskLo & conflictMaskLo) !== 0 || (currentMaskHi & conflictMaskHi) !== 0) continue;
                const weight = poolPlan.weights[i]!;
                const enchant = poolPlan.pool[i]! as PackedEnchant;
                totalWeight += weight;
                if (cluePolicy && !cluePolicy.canSelectChild(enchant, targetAlreadySelected)) {
                    ctx.graph.appendBlueprintEdge(SearchNodeGraph.PRUNED_CHILD_ID, weight);
                    eligibleCount++;
                    continue;
                }

                const childMaskLo = (currentMaskLo | idMaskLo) >>> 0;
                const childMaskHi = (currentMaskHi | idMaskHi) >>> 0;
                let childId = ctx.graph.getNumericNodeId(childMaskLo, childMaskHi, nextLevel);
                if (childId === undefined) {
                    const childCombo = ComboUtils.packAppendIndex(currentCombo, poolPlan.comboIndices[i]!, currentCount);
                    childId = ctx.graph.createNumericNode(childMaskLo, childMaskHi, nextLevel, childCombo, currentCount + 1);
                }
                ctx.graph.appendBlueprintEdge(childId, weight);
                eligibleCount++;
            }
        } else {
            const currentBitset = ctx.graph.getMeta(nodeId) >> BIGINT_CONSTANTS.ENCHANT_SHIFT;

            for (let i = 0; i < poolPlan.length; i++) {
                const idBit = poolPlan.idBits[i]!;
                if ((currentBitset & idBit) !== 0n) continue;
                const conflictBitset = poolPlan.conflictBitsets[i]!;
                if ((currentBitset & conflictBitset) !== 0n) continue;
                const weight = poolPlan.weights[i]!;
                const enchant = poolPlan.pool[i]! as PackedEnchant;
                totalWeight += weight;
                if (cluePolicy && !cluePolicy.canSelectChild(enchant, targetAlreadySelected)) {
                    ctx.graph.appendBlueprintEdge(SearchNodeGraph.PRUNED_CHILD_ID, weight);
                    eligibleCount++;
                    continue;
                }

                const childMeta = ((currentBitset | idBit) << BIGINT_CONSTANTS.ENCHANT_SHIFT) | nextLevelBits;
                const childCombo = ComboUtils.packAppend(currentCombo, enchant, registry.enchantToIndex);
                const childId = ctx.graph.getOrCreateBigIntNode(childMeta, childCombo, currentCount + 1);
                ctx.graph.appendBlueprintEdge(childId, weight);
                eligibleCount++;
            }
        }

        return {
            probContinue,
            totalWeight,
            eligibleCount,
            edgeStart,
            currentCount,
            currentCombo
        };
    }
}
