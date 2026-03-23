import { BinaryHeap, PRECISION, ProbUtils, ComboUtils, RomanUtils } from '../utils/index.js';
import { Registry } from '../registry.js';
import { ENGINE_DEFAULTS } from '../config.js';
import { PackedNode, PackedCombo, PackedEnchant } from '../utils/types.js';

/**
 * State of a search for enchantment combinations.
 */
export interface SearchFrontier {
    queue: BinaryHeap<PackedNode>;
    results: Map<PackedCombo, bigint>;
    anyMass: Map<number, bigint>;
    rankMass: Map<number, bigint>;
    countMass: Map<number, bigint>;
    uncertainty: bigint;
    cumulativeAccountedMass: bigint;
    prunedMass: bigint;
    threshold: bigint;
}

/**
 * Service for the Best-First search of enchantment combinations.
 */
export class SearchService {
    /**
     * Iteratively calculates enchantment combinations using a Best-First approach.
     */
    public static calculateCombinations(
        registry: Registry,
        cat: string, 
        modLevel: number, 
        mat: string, 
        guaranteedFirst: string | null = null, 
        threshold: bigint = ProbUtils.toBigInt(0.0001),
        limit: number,
        existingFrontier?: SearchFrontier
    ): SearchFrontier {
        const frontier = this.initializeSearchFrontier(registry, cat, modLevel, guaranteedFirst, existingFrontier, threshold);
        let { results, uncertainty, cumulativeAccountedMass, prunedMass, queue } = frontier;
        
        const guaranteedFirstId = this.getGuaranteedFirstId(registry, guaranteedFirst);

        let iterations = 0;

        const initialPool = registry.getEligiblePool(cat, modLevel, mat);
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
                const rem = this.processInitialNode(current, modLevel, guaranteedFirstId, initialPool, poolWeights, initialTotalWeight, queue, frontier.anyMass, frontier.rankMass);
                uncertainty += rem;
                cumulativeAccountedMass += rem;
                prunedMass += rem;
                continue;
            }

            const deltas = this.processSearchNode(
                registry, current, cat, guaranteedFirstId, initialPool, poolWeights, threshold, results, queue,
                frontier.anyMass, frontier.rankMass, frontier.countMass
            );
            
            uncertainty += deltas.uncertaintyDelta;
            cumulativeAccountedMass += deltas.massDelta;
            prunedMass += deltas.prunedDelta;
        }

        let frontierUncertainty = 0n;
        for (const item of queue.items) {
            frontierUncertainty += item.prob;
        }

        return { ...frontier, uncertainty: uncertainty + frontierUncertainty, prunedMass };
    }

    private static getGuaranteedFirstId(registry: Registry, guaranteedFirst: string | null): number | null {
        if (!guaranteedFirst) return null;
        const romanMap = registry.data.constants.ROMAN_MAP;
        const base = RomanUtils.getBaseName(guaranteedFirst, romanMap);
        const id = registry.getEnchantId(base);
        return id !== ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID ? id : null;
    }

    private static initializeSearchFrontier(
        registry: Registry,
        cat: string,
        modLevel: number,
        guaranteedFirst: string | null,
        existing?: SearchFrontier,
        threshold: bigint = 0n
    ): SearchFrontier {
        if (existing) {
            return {
                queue: existing.queue.clone(),
                results: new Map(existing.results),
                anyMass: new Map(existing.anyMass),
                rankMass: new Map(existing.rankMass),
                countMass: new Map(existing.countMass),
                uncertainty: existing.uncertainty,
                cumulativeAccountedMass: existing.cumulativeAccountedMass,
                prunedMass: existing.prunedMass || 0n,
                threshold: existing.threshold
            };
        }

        const results = new Map<PackedCombo, bigint>();
        const queue = new BinaryHeap<PackedNode>((item) => item.meta);
        const anyMass = new Map<number, bigint>();
        const rankMass = new Map<number, bigint>();
        const countMass = new Map<number, bigint>();

        const romanMap = registry.data.constants.ROMAN_MAP;
        const guaranteedId = this.getGuaranteedFirstId(registry, guaranteedFirst);
        
        const rankStr = guaranteedFirst?.split(' ').pop();
        const rank = rankStr ? RomanUtils.getRomanValue(rankStr, romanMap) : null;
        const full = (guaranteedId !== null && rank !== null) ? (guaranteedId << 8 | rank) : null;

        const initialPacked = full !== null ? ComboUtils.pack([full], guaranteedId) : 0n;
        const initialBitset = guaranteedId !== null ? (1n << BigInt(guaranteedId)) : 0n;

        if (full !== null && guaranteedId !== null) {
            anyMass.set(guaranteedId, PRECISION);
            rankMass.set(full, PRECISION);
        }

        queue.push({
            packedChosen: initialPacked,
            meta: (initialBitset << 8n) | BigInt(modLevel),
            prob: PRECISION
        });

        return { 
            queue, results, anyMass, rankMass, countMass,
            uncertainty: 0n, cumulativeAccountedMass: 0n, prunedMass: 0n, threshold 
        };
    }

    private static processSearchNode(
        registry: Registry,
        current: PackedNode,
        cat: string,
        guaranteedFirstId: number | null,
        pool: PackedEnchant[],
        poolWeights: number[],
        threshold: bigint,
        results: Map<PackedCombo, bigint>,
        queue: BinaryHeap<PackedNode>,
        anyMass: Map<number, bigint>,
        rankMass: Map<number, bigint>,
        countMass: Map<number, bigint>
    ): { uncertaintyDelta: bigint; massDelta: bigint; prunedDelta: bigint } {
        const currentBitset = current.meta >> 8n;
        const currentLevel = Number(current.meta & 0xFFn);
        const currentCount = ComboUtils.getCount(current.packedChosen);

        const probContinueNum = (cat === "book" && !registry.multiEnchantBooks) ? 0 : Math.min((currentLevel + 1) / ENGINE_DEFAULTS.MAX_MODIFIED_LEVEL_FOR_CONTINUING, 1.0);
        const probContinue = ProbUtils.toBigInt(probContinueNum);

        if (probContinue <= 0n) {
            results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + current.prob);
            countMass.set(currentCount, (countMass.get(currentCount) || 0n) + current.prob);
            return { uncertaintyDelta: 0n, massDelta: current.prob, prunedDelta: 0n };
        }

        const probStop = ProbUtils.scale(current.prob, (PRECISION - probContinue));
        results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probStop);
        countMass.set(currentCount, (countMass.get(currentCount) || 0n) + probStop);
        
        const probForward = ProbUtils.scale(current.prob, probContinue);

        // Safety checks
        const isLimitReached = currentCount >= ENGINE_DEFAULTS.MAX_ENCHANTS_PER_ITEM;
        const isTooSmall = probForward < threshold / ENGINE_DEFAULTS.PRUNE_THRESHOLD_DENOMINATOR;
        const isMapFull = results.size >= ENGINE_DEFAULTS.MAX_RESULTS_SIZE && !results.has(current.packedChosen);

        if (isLimitReached || isTooSmall || isMapFull) {
            results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probForward);
            countMass.set(currentCount, (countMass.get(currentCount) || 0n) + probForward);
            return { uncertaintyDelta: probForward, massDelta: probStop + probForward, prunedDelta: probForward };
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
            return { uncertaintyDelta: 0n, massDelta: probStop + probForward, prunedDelta: 0n };
        }

        const nextLevel = currentCount >= 1 ? Math.floor(currentLevel / 2) : currentLevel;
        const pBase = probForward / BigInt(totalWeight);
        const remainder = probForward % BigInt(totalWeight);
        const currentChosen = ComboUtils.unpack(current.packedChosen);

        for (let i = 0; i < eligible.length; i++) {
            if (queue.size() >= ENGINE_DEFAULTS.MAX_QUEUE_SIZE) {
                results.set(current.packedChosen, (results.get(current.packedChosen) || 0n) + probForward);
                countMass.set(currentCount, (countMass.get(currentCount) || 0n) + probForward);
                return { uncertaintyDelta: probForward, massDelta: probStop + probForward, prunedDelta: probForward };
            }
            
            const pNext = BigInt(weights[i]) * pBase;
            const nextPacked = ComboUtils.pack([...currentChosen, eligible[i]], guaranteedFirstId);
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

        return { uncertaintyDelta: remainder, massDelta: probStop + remainder, prunedDelta: remainder };
    }

    private static processInitialNode(
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
        const pBase = current.prob / BigInt(totalWeight);
        const remainder = current.prob % BigInt(totalWeight);
        for (let i = 0; i < pool.length; i++) {
            const pNext = BigInt(weights[i]) * pBase;
            const nextId = pool[i] >> 8;
            
            anyMass.set(nextId, (anyMass.get(nextId) || 0n) + pNext);
            rankMass.set(pool[i], (rankMass.get(pool[i]) || 0n) + pNext);

            queue.push({
                packedChosen: ComboUtils.pack([pool[i]], guaranteedId),
                meta: ((1n << BigInt(nextId)) << 8n) | BigInt(modLevel),
                prob: pNext
            });
        }
        return remainder;
    }
}
