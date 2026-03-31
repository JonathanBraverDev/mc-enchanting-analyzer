import { BinaryHeap, PRECISION, ProbUtils, ComboUtils, LRUCache } from '../utils/index.js';
import { getEligiblePool } from '../core/registry.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { PackedNode, PackedCombo, PackedEnchant, SearchFrontier, RegistryState } from '../types/index.js';
import { FrontierFactory } from './frontier.js';

/**
 * Service for the Best-First search of enchantment combinations.
 */
export class SearchService {
    /**
     * Iteratively calculates enchantment combinations using a Best-First approach.
     */
    public static calculateCombinations(
        registry: RegistryState,
        cat: string,
        modLevel: number,
        mat: string,
        guaranteedFirst: string | null = null,
        threshold: bigint = ProbUtils.toBigInt(0.0001),
        limit: number,
        existingFrontier?: SearchFrontier,
        resultsLimit: number = ENGINE_DEFAULTS.MAX_RESULTS_SIZE,
        poolCache?: LRUCache<string, PackedEnchant[]>
    ): SearchFrontier {
        const frontier = FrontierFactory.create(registry, cat, modLevel, guaranteedFirst, existingFrontier, threshold);
        let { results, cumulativeAccountedMass, prunedMass, roundingError, queue } = frontier;

        const guaranteedFirstId = FrontierFactory.getGuaranteedFirstId(registry, guaranteedFirst);

        let uncertainty = prunedMass;
        let iterations = 0;

        const initialPool = getEligiblePool(registry, cat, modLevel, mat, poolCache);
        if (initialPool.length === 0) {
            return {
                queue: new BinaryHeap(),
                results: new Map(),
                anyMass: new Map(),
                rankMass: new Map(),
                countMass: new Map([[0, PRECISION]]),
                uncertainty: 0n,
                cumulativeAccountedMass: PRECISION,
                prunedMass: 0n,
                roundingError: 0n,
                threshold
            };
        }

        const poolWeights = initialPool.map(e => registry.weightMap[e >> 8]);
        const initialTotalWeight = poolWeights.reduce((a, b) => a + b, 0);

        while (queue.size() > 0 && iterations < limit && cumulativeAccountedMass < (PRECISION - (PRECISION / ENGINE_DEFAULTS.MASS_ACCOUNTED_THRESHOLD_DENOMINATOR))) {
            const next = queue.peek()!;
            if (next.prob < threshold / 10n) break;

            iterations++;
            const current = queue.pop()!;
            const currentCount = ComboUtils.getCount(current.packedChosen);

            if (currentCount === 0) {
                const rem = this.processInitialNode(registry, current, modLevel, guaranteedFirstId, initialPool, poolWeights, initialTotalWeight, queue, frontier.anyMass, frontier.rankMass);
                uncertainty += rem;
                cumulativeAccountedMass += rem;
                prunedMass += rem;
                continue;
            }

            const deltas = this.processSearchNode(
                registry, current, currentCount, cat, guaranteedFirstId, initialPool, poolWeights, threshold, results, queue,
                frontier.anyMass, frontier.rankMass, frontier.countMass, resultsLimit
            );

            uncertainty += deltas.uncertaintyDelta;
            roundingError += deltas.roundingErrorDelta;
            cumulativeAccountedMass += deltas.massDelta;
            prunedMass += deltas.prunedDelta;
        }

        let frontierUncertainty = 0n;
        for (const item of queue.items) {
            frontierUncertainty += item.prob;
        }

        return { ...frontier, uncertainty: uncertainty + frontierUncertainty, prunedMass: uncertainty, roundingError };
    }

    private static processSearchNode(
        registry: RegistryState,
        current: PackedNode,
        currentCount: number,
        cat: string,
        guaranteedFirstId: number | null,
        pool: PackedEnchant[],
        poolWeights: number[],
        threshold: bigint,
        results: Map<PackedCombo, bigint>,
        queue: BinaryHeap<PackedNode>,
        anyMass: Map<number, bigint>,
        rankMass: Map<number, bigint>,
        countMass: Map<number, bigint>,
        resultsLimit: number
    ): { uncertaintyDelta: bigint; massDelta: bigint; prunedDelta: bigint; roundingErrorDelta: bigint } {
        const { enchantToIndex, indexToEnchant } = registry;
        const currentBitset = current.meta >> 8n;
        const currentLevel = Number(current.meta & 0xFFn);

        const probContinueNum = (cat === "book" && !registry.multiEnchantBooks) ? 0 : Math.min((currentLevel + 1) / ENGINE_DEFAULTS.MAX_MODIFIED_LEVEL_FOR_CONTINUING, 1.0);
        const probContinue = ProbUtils.toBigInt(probContinueNum);

        if (probContinue <= 0n) {
            let rem = 0n;
            if (cat === "book" && currentCount > 1) {
                const { pChunk, rem: r } = this.redistributeBookProb(current.packedChosen, current.prob, currentCount, guaranteedFirstId, enchantToIndex, indexToEnchant, results, countMass);
                rem = r;
                const enchants = ComboUtils.unpack(current.packedChosen, indexToEnchant);
                for (let i = 1; i < enchants.length; i++) {
                    const id = enchants[i] >> 8;
                    anyMass.set(id, (anyMass.get(id) || 0n) - (pChunk + rem));
                    rankMass.set(enchants[i], (rankMass.get(enchants[i]) || 0n) - (pChunk + rem));
                }
                return { uncertaintyDelta: 0n, massDelta: current.prob, prunedDelta: 0n, roundingErrorDelta: rem };
            } else {
                results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + current.prob);
                countMass.set(currentCount, (countMass.get(currentCount) || 0n) + current.prob);
                return { uncertaintyDelta: 0n, massDelta: current.prob, prunedDelta: 0n, roundingErrorDelta: 0n };
            }
        }

        const probStop = ProbUtils.scale(current.prob, (PRECISION - probContinue));
        let remStop = 0n;
        if (cat === "book" && currentCount > 1) {
            const { redistributed, rem } = this.redistributeBookProb(current.packedChosen, probStop, currentCount, guaranteedFirstId, enchantToIndex, indexToEnchant, results, countMass);
            remStop = rem;
            const nOutcomes = BigInt(redistributed.length);

            // Correctly attribute mass based on survival across all outcomes
            const originalEnchants = ComboUtils.unpack(current.packedChosen, indexToEnchant);

            for (const e of originalEnchants) {
                const id = e >> 8;
                // Count how many of the redistributed results still contain this enchantment
                const nOccurrences = redistributed.filter(r => ComboUtils.unpack(r, indexToEnchant).some(re => re === e)).length;
                const survivorMass = (BigInt(nOccurrences) * probStop) / nOutcomes;
                const loss = probStop - survivorMass;

                if (loss > 0n) {
                    anyMass.set(id, (anyMass.get(id) || 0n) - loss);
                    rankMass.set(e, (rankMass.get(e) || 0n) - loss);
                }
            }
        } else {
            results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probStop);
            countMass.set(currentCount, (countMass.get(currentCount) || 0n) + probStop);
        }

        const probForward = ProbUtils.scale(current.prob, probContinue);

        // Safety checks
        const isLimitReached = currentCount >= ENGINE_DEFAULTS.MAX_ENCHANTS_PER_ITEM;
        const isTooSmall = probForward < threshold / ENGINE_DEFAULTS.PRUNE_THRESHOLD_DENOMINATOR;
        const isMapFull = results.size >= resultsLimit && !results.has(current.packedChosen);

        if (isLimitReached || isTooSmall || isMapFull) {
            let remForward = 0n;
            if (cat === "book" && currentCount > 1) {
                const { pChunk, rem } = this.redistributeBookProb(current.packedChosen, probForward, currentCount, guaranteedFirstId, enchantToIndex, indexToEnchant, results, countMass);
                remForward = rem;
                const enchants = ComboUtils.unpack(current.packedChosen, indexToEnchant);
                for (let i = 1; i < enchants.length; i++) {
                    const id = enchants[i] >> 8;
                    anyMass.set(id, (anyMass.get(id) || 0n) - (pChunk + remForward));
                    rankMass.set(enchants[i], (rankMass.get(enchants[i]) || 0n) - (pChunk + remForward));
                }
                return { uncertaintyDelta: 0n, massDelta: probStop + probForward, prunedDelta: probForward, roundingErrorDelta: remStop + remForward };
            } else {
                results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probForward);
                countMass.set(currentCount, (countMass.get(currentCount) || 0n) + probForward);
                return { uncertaintyDelta: probForward, massDelta: probStop + probForward, prunedDelta: probForward, roundingErrorDelta: remStop };
            }
        }

        // Branching
        let totalWeight = 0;
        const eligible: PackedEnchant[] = [];
        const weights: number[] = [];

        for (let i = 0; i < pool.length; i++) {
            const e = pool[i];
            const id = ComboUtils.getEnchantId(e);
            if ((currentBitset & (1n << BigInt(id))) !== 0n) continue;
            if ((currentBitset & registry.conflictBitsets[id]) !== 0n) continue;
            eligible.push(e);
            weights.push(poolWeights[i]);
            totalWeight += poolWeights[i];
        }

        if (totalWeight === 0) {
            results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probForward);
            countMass.set(currentCount, (countMass.get(currentCount) || 0n) + probForward);
            return { uncertaintyDelta: 0n, massDelta: probStop + probForward, prunedDelta: 0n, roundingErrorDelta: remStop };
        }

        const nextLevel = currentCount >= 1 ? Math.floor(currentLevel / 2) : currentLevel;
        const pBase = probForward / BigInt(totalWeight);
        const remainder = probForward % BigInt(totalWeight);
        const currentChosen = ComboUtils.unpack(current.packedChosen, indexToEnchant);

        for (let i = 0; i < eligible.length; i++) {
            if (queue.size() >= ENGINE_DEFAULTS.MAX_QUEUE_SIZE) {
                results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probForward);
                countMass.set(currentCount, (countMass.get(currentCount) || 0n) + probForward);
                return { uncertaintyDelta: probForward, massDelta: probStop + probForward, prunedDelta: probForward, roundingErrorDelta: remStop };
            }

            const pNext = BigInt(weights[i]) * pBase;
            const nextPacked = ComboUtils.pack([...currentChosen, eligible[i]], guaranteedFirstId, enchantToIndex);
            const nextId = ComboUtils.getEnchantId(eligible[i]);

            // Add new enchant to Rank and Any mass of this path
            anyMass.set(nextId, (anyMass.get(nextId) || 0n) + pNext);
            rankMass.set(eligible[i], (rankMass.get(eligible[i]) || 0n) + pNext);

            queue.push({
                packedChosen: nextPacked,
                meta: ((currentBitset | (1n << BigInt(nextId))) << 8n) | BigInt(nextLevel),
                prob: pNext
            });
        }

        return { uncertaintyDelta: remainder, massDelta: probStop + remainder, prunedDelta: remainder, roundingErrorDelta: remStop };
    }

    /**
     * Common core of book redistribution: calls removeAdditional, splits `prob` equally across
     * all N→(N-1) outcomes, writes each chunk to `results`, updates `countMass`, and returns the
     * redistributed combos, per-chunk probability, and integer remainder for the caller to use in
     * its own mass-tracking logic.
     */
    private static redistributeBookProb(
        packedChosen: PackedCombo,
        prob: bigint,
        currentCount: number,
        guaranteedFirstId: number | null,
        enchantToIndex: Map<number, number>,
        indexToEnchant: number[],
        results: Map<PackedCombo, bigint>,
        countMass: Map<number, bigint>
    ): { redistributed: PackedCombo[]; pChunk: bigint; rem: bigint } {
        const redistributed = ComboUtils.removeAdditional(packedChosen, guaranteedFirstId, enchantToIndex, indexToEnchant);
        const nOutcomes = BigInt(redistributed.length);
        const rem = prob % nOutcomes;
        const pChunk = prob / nOutcomes;
        for (const r of redistributed) {
            results.set(r, (results.get(r) || 0n) + pChunk);
        }
        countMass.set(currentCount - 1, (countMass.get(currentCount - 1) || 0n) + (prob - rem));
        return { redistributed, pChunk, rem };
    }

    private static processInitialNode(
        registry: RegistryState,
        current: PackedNode,
        modLevel: number,
        guaranteedId: number | null,
        pool: PackedEnchant[],
        weights: number[],
        totalWeight: number,
        queue: BinaryHeap<PackedNode>,
        anyMass: Map<number, bigint>,
        rankMass: Map<number, bigint>
    ): bigint {
        const { enchantToIndex } = registry;
        const pBase = current.prob / BigInt(totalWeight);
        const remainder = current.prob % BigInt(totalWeight);
        for (let i = 0; i < pool.length; i++) {
            const pNext = BigInt(weights[i]) * pBase;
            const nextId = pool[i] >> 8;

            anyMass.set(nextId, (anyMass.get(nextId) || 0n) + pNext);
            rankMass.set(pool[i], (rankMass.get(pool[i]) || 0n) + pNext);

            queue.push({
                packedChosen: ComboUtils.pack([pool[i]], guaranteedId, enchantToIndex),
                meta: ((1n << BigInt(nextId)) << 8n) | BigInt(modLevel),
                prob: pNext
            });
        }
        return remainder;
    }
}
