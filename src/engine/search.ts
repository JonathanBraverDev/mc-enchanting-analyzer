import { SearchHeap } from '../utils/collections/SearchHeap.js';
import { PRECISION, ProbUtils, ComboUtils, LRUCache, AsyncUtils } from '../utils/index.js';
import { getEligiblePool } from '../core/registry.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { PackedNode, PackedCombo, PackedEnchant, SearchFrontier, RegistryState, EngineInstrumentation, MassCheckpoint, EngineExitReason, SearchTiming } from '../types/index.js';
import { FrontierFactory } from './frontier.js';
import { MassAccountant } from './MassAccountant.js';


/**
 * Service for the Best-First search of enchantment combinations.
 */
export class SearchService {
    private static _splitsBuffer = new BigUint64Array(128);

    private static readonly PROB_CONTINUE_TABLE: bigint[] = Array.from({ length: 65 }, (_, ml) => {
        const val = Math.min((ml + 1) / ENGINE_DEFAULTS.MAX_MODIFIED_LEVEL_FOR_CONTINUING, 1.0);
        return ProbUtils.toBigInt(val);
    });

    private static readonly CHECKPOINT_TARGETS_BIGINT: bigint[] = [
        0.1, 0.25, 0.5, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99, 0.999
    ].map(t => ProbUtils.toBigInt(t));
    /**
     * Iteratively calculates enchantment combinations using a Best-First approach.
     */
    public static async calculateCombinations(
        registry: RegistryState,
        cat: string,
        modLevel: number,
        _mat: string,
        guaranteedFirst: string | null = null,
        threshold: bigint = ProbUtils.toBigInt(0.0001),
        limit: number,
        existingFrontier?: SearchFrontier,
        resultsLimit: number = ENGINE_DEFAULTS.MAX_RESULTS_SIZE,
        poolCache?: LRUCache<string, PackedEnchant[]>,
        signal?: AbortSignal,
        instrumentation?: EngineInstrumentation,
        floor: bigint = threshold,
        timingResult?: SearchTiming
    ): Promise<SearchFrontier> {
        let startTime = 0;
        if (timingResult) startTime = performance.now();
        
        const timing = timingResult ? {
            totalMs: 0,
            searchMs: 0,
            filteringMs: 0,
            distributionMs: 0,
            settlingMs: 0,
            heapMs: 0
        } : undefined;

        const frontier = FrontierFactory.create(registry, cat, modLevel, guaranteedFirst, existingFrontier, threshold);
        const { results, queue } = frontier;
        // Initialize accountant and ALWAYS reset pending mass
        // since we will accurately recount it from the current queue at the end of the call.
        const accountant = new MassAccountant(frontier.mass);
        // Queue mass is already included in frontier.mass.pending.
        // Incremental updates will maintain it during push/pop.
        const BK = accountant.getBookkeeping();
        void BK;

        let iterations = 0;
        const expandedIds = new Set<bigint>();
        let redundantExpansions = 0;

        const guaranteedFirstId = FrontierFactory.getGuaranteedFirstId(registry, guaranteedFirst);

        const initialPool = getEligiblePool(registry, cat, modLevel, poolCache);
        if (initialPool.length === 0) {
            const rootAcc = new MassAccountant();
            rootAcc.record('resolved', PRECISION);
            const anyMass = new BigUint64Array(256);
            const rankMass = new BigUint64Array(16384);
            const countMass = new BigUint64Array(16);
            countMass[0] = PRECISION;

            return {
                queue: new SearchHeap(),
                results: new Map(),
                anyMass,
                rankMass,
                countMass,
                mass: rootAcc.getBookkeeping(),
                threshold,
                iterations: 0,
                nodesProcessed: 0,
                expansionCache: new Map(),
                checkpoints: [],
                exitReason: 'empty'
            };
        }

        const poolWeights = initialPool.map(e => registry.weightMap[e >> 8]);
        const initialTotalWeight = poolWeights.reduce((a, b) => a + b, 0);

        // Removed redundant loop stub

        const localCheckpoints: MassCheckpoint[] = [];
        let checkpointIdx = 0;
        let exitReason: EngineExitReason | undefined;

        // Reusable node for popFast to avoid allocations
        const current = { meta: 0n, prob: 0n, level: 0, combo: 0 };

        while (queue.size() > 0 && iterations < limit) {
            const nextProb = queue.peekProb();

            if (iterations > 0 && iterations % 1000 === 0) {
                if (instrumentation) {
                    instrumentation.queueSize = queue.size();
                    instrumentation.indexMapSize = queue.indexMapSize;
                    instrumentation.resultsSize = results.size;
                }
                await AsyncUtils.yield();
                if (signal?.aborted) {
                    if (instrumentation) instrumentation.exitReason = 'aborted';
                    break;
                }
            }

            if (nextProb < threshold) {
                exitReason = 'threshold';
                break;
            }

            if (queue.size() > 1000000) {
                exitReason = 'exhausted';
                break;
            }

            iterations++;
            frontier.nodesProcessed++;
            
            let popStart = 0;
            if (timing) popStart = performance.now();
            if (!queue.popFast(current)) break;
            if (timing) timing.heapMs += performance.now() - popStart;

            if (expandedIds.has(current.meta)) {
                redundantExpansions++;
            } else {
                expandedIds.add(current.meta);
            }

            accountant.subtract('pending', current.prob);
            const currentCount = ComboUtils.getCount(current.combo);

            let procStart = 0;
            if (timing) procStart = performance.now();

            if (currentCount === 0) {
                this.processInitialNode(registry, current.prob, current.meta, modLevel, guaranteedFirstId, initialPool, poolWeights, initialTotalWeight, queue, frontier.anyMass, frontier.rankMass, accountant, timing);
            } else {
                this.processSearchNode(
                    registry, current.prob, current.meta, current.combo, currentCount, cat, guaranteedFirstId, initialPool, poolWeights, results, queue,
                    frontier.anyMass, frontier.rankMass, frontier.countMass, resultsLimit, accountant, frontier.expansionCache, instrumentation, timing
                );
            }

            if (timing) timing.searchMs += performance.now() - procStart;

            // Checkpoints: record after processing — current.prob is the minimum threshold
            // needed to have processed this node (and thus reached this mass coverage).
            const bk = accountant.getBookkeeping();
            while (checkpointIdx < SearchService.CHECKPOINT_TARGETS_BIGINT.length) {
                const targetMass = SearchService.CHECKPOINT_TARGETS_BIGINT[checkpointIdx];
                const currentSettledMass = bk.resolved + bk.sieved + bk.overflow;
                if (currentSettledMass < targetMass) break;
                localCheckpoints.push({
                    modLevel,
                    threshold: ProbUtils.toNumber(current.prob),
                    mass: ProbUtils.toNumber(currentSettledMass),
                    iterations,
                    totalIterations: iterations
                });
                checkpointIdx++;
            }
        }

        if (!exitReason) {
            if (queue.size() === 0) exitReason = 'empty';
            else if (iterations >= limit) exitReason = 'iterations';
            else if (queue.size() > 1000000) exitReason = 'exhausted';
            else exitReason = 'threshold';
        }

        if (timingResult && timing) {
            timing.totalMs = performance.now() - startTime;
            timingResult.totalMs += timing.totalMs;
            timingResult.searchMs += timing.searchMs;
            timingResult.filteringMs += timing.filteringMs;
            timingResult.distributionMs += timing.distributionMs;
            timingResult.settlingMs += timing.settlingMs;
            timingResult.heapMs += timing.heapMs;
        }

        if (redundantExpansions > 0) {
            console.log(`Redundant expansions: ${redundantExpansions} / ${iterations} (${(redundantExpansions/iterations*100).toFixed(1)}%)`);
        }
        
        return { ...frontier, mass: accountant.getBookkeeping(), iterations, checkpoints: localCheckpoints, exitReason };
    }

    private static processSearchNode(
        registry: RegistryState,
        currentProb: bigint,
        currentMeta: bigint,
        currentCombo: number,
        currentCount: number,
        cat: string,
        guaranteedFirstId: number | null,
        pool: PackedEnchant[],
        poolWeights: number[],
        results: Map<PackedCombo, bigint>,
        queue: SearchHeap,
        anyMass: BigUint64Array,
        rankMass: BigUint64Array,
        countMass: BigUint64Array,
        resultsLimit: number,
        accountant: MassAccountant,
        expansionCache: Map<bigint, import('../types/engine.js').ExpansionBlueprint>,
        instrumentation?: EngineInstrumentation,
        timing?: SearchTiming
    ): void {

        const { enchantToIndex, indexToEnchant } = registry;
        const currentBitset = currentMeta >> 8n;
        const currentLevel = Number(currentMeta & 0xFFn);
        const isBook = cat === "book";
        // Unpack once for reuse.
        const currentEnchants = (isBook && currentCount > 1)
            ? ComboUtils.unpack(currentCombo, indexToEnchant)
            : [] as PackedEnchant[];

        const probContinue = (isBook && !registry.multiEnchantBooks && currentCount >= 1)
            ? 0n
            : (SearchService.PROB_CONTINUE_TABLE[currentLevel] || 0n);

        let startSettling = 0;
        if (timing) startSettling = performance.now();
        const probStop = ProbUtils.scale(currentProb, (PRECISION - probContinue));
        const remStop = this.settleMass(registry, isBook, currentCount, currentCombo, currentEnchants, probStop, guaranteedFirstId, enchantToIndex, indexToEnchant, results, countMass, anyMass, rankMass);

        const probForward = ProbUtils.scale(currentProb, probContinue);

        // Safety checks
        const floor = ProbUtils.toBigInt(ENGINE_DEFAULTS.SYSTEM_THRESHOLD_FLOOR);
        const isLimitReached = currentCount >= (isBook && !registry.multiEnchantBooks ? 1 : ENGINE_DEFAULTS.MAX_ENCHANTS_PER_ITEM);
        const isTooSmall = probForward < floor;
        const isMapFull = results.size >= resultsLimit && !results.has(currentCombo);

        if (isLimitReached || isTooSmall || isMapFull) {
            const remForward = this.settleMass(registry, isBook, currentCount, currentCombo, currentEnchants, probForward, guaranteedFirstId, enchantToIndex, indexToEnchant, results, countMass, anyMass, rankMass);
            if (timing) timing.settlingMs += performance.now() - startSettling;
            
            // In Banker's Rounding land, stop + forward approx currentProb.
            // Any discrepency is recorded as rounding error.
            const localRounding = remStop + remForward + (currentProb - (probStop + probForward));
            
            accountant.record('resolved', probStop - remStop);
            accountant.record('rounding', localRounding);
            
            if (isTooSmall) {
                if (instrumentation) instrumentation.totalPrunedNodes++;
                accountant.record('sieved', probForward - remForward);
            } else if (isLimitReached) {
                accountant.record('overflow', probForward - remForward);
            } else {
                accountant.record('capped', probForward - remForward);
            }

            if (localRounding > 0n && instrumentation) instrumentation.roundingErrorEvents++;
            return;
        }

        if (timing) timing.settlingMs += performance.now() - startSettling;

        // Branching & Expansion Cache
        let startFiltering = 0;
        if (timing) startFiltering = performance.now();
        
        let eligible: Int32Array;
        let weights: Int32Array;
        let eligibleCount: number;
        let totalWeight: number;
        let nextLevel: number;
        
        const cached = expansionCache.get(currentMeta);
        if (cached) {
            eligible = cached.eligibleEnchants;
            weights = cached.eligibleWeights;
            eligibleCount = cached.eligibleCount;
            totalWeight = cached.totalWeight;
            nextLevel = cached.nextLevel;
        } else {
            const tempEligible = new Int32Array(pool.length);
            const tempWeights = new Int32Array(pool.length);
            eligibleCount = 0;
            totalWeight = 0;

            for (let i = 0; i < pool.length; i++) {
                const e = pool[i];
                const id = ComboUtils.getEnchantId(e);
                if ((currentBitset & (1n << BigInt(id))) !== 0n) continue;
                if ((currentBitset & registry.conflictBitsets[id]) !== 0n) continue;
                tempEligible[eligibleCount] = e;
                tempWeights[eligibleCount] = poolWeights[i];
                eligibleCount++;
                totalWeight += poolWeights[i];
            }
            
            nextLevel = currentCount >= 1 ? Math.floor(currentLevel / 2) : currentLevel;
            eligible = tempEligible.slice(0, eligibleCount);
            weights = tempWeights.slice(0, eligibleCount);
            
            expansionCache.set(currentMeta, {
                probContinue,
                totalWeight,
                eligibleCount,
                eligibleEnchants: eligible,
                eligibleWeights: weights,
                nextLevel,
                currentCount,
                currentCombo,
                currentEnchants
            });
        }
        
        if (timing) timing.filteringMs += performance.now() - startFiltering;

        if (totalWeight === 0) {
            let startEndSettling = 0;
            if (timing) startEndSettling = performance.now();
            const remForward = this.settleMass(registry, isBook, currentCount, currentCombo, currentEnchants, probForward, guaranteedFirstId, enchantToIndex, indexToEnchant, results, countMass, anyMass, rankMass);
            if (timing) timing.settlingMs += performance.now() - startEndSettling;

            const localRounding = remStop + remForward + (currentProb - (probStop + probForward));

            accountant.record('resolved', (probStop + probForward) - (remStop + remForward));
            accountant.record('rounding', localRounding);
            if (localRounding > 0n && instrumentation) instrumentation.roundingErrorEvents++;
            return;
        }

        let startDist = 0;
        if (timing) startDist = performance.now();
        const splitRemainder = ProbUtils.distributeDetailed(probForward, weights, totalWeight, SearchService._splitsBuffer, eligibleCount);
        const splits = SearchService._splitsBuffer;
        if (timing) timing.distributionMs += performance.now() - startDist;

        const guaranteedInCombo = guaranteedFirstId !== null && (currentBitset & (1n << BigInt(guaranteedFirstId))) !== 0n;

        let startHeap = 0;
        if (timing) startHeap = performance.now();
        for (let i = 0; i < eligibleCount; i++) {
            const pNext = splits[i];
            const nextPacked = ComboUtils.packAppend(currentCombo, eligible[i], guaranteedFirstId, guaranteedInCombo, enchantToIndex);
            const nextId = ComboUtils.getEnchantId(eligible[i]);
            const nextMeta = ((currentBitset | (1n << BigInt(nextId))) << 8n) | BigInt(nextLevel);

            // Add new enchant to Rank and Any mass of this path
            ProbUtils.addItemMass(anyMass, nextId, pNext);
            ProbUtils.addItemMass(rankMass, eligible[i], pNext);

            accountant.record('pending', pNext);
            queue.pushOrMerge(nextMeta, pNext, nextLevel, nextPacked);
        }

        if (timing) timing.heapMs += performance.now() - startHeap;

        const scaleRoundingLoss = currentProb - (probStop + probForward);
        accountant.record('resolved', probStop - remStop);
        accountant.record('rounding', remStop + scaleRoundingLoss + splitRemainder);

        if ((remStop + scaleRoundingLoss + splitRemainder) > 0n && instrumentation) instrumentation.roundingErrorEvents++;
    }

    /** Settles `prob` into results/countMass, via book redistribution when applicable, and returns rem. */
    public static settleMass(
        _registry: RegistryState,
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
     * outcomes, writes each chunk to `results`, updates `countMass`, corrects `anyMass`/`rankMass`,
     * and returns the integer remainder. The caller should add `rem` to `roundingErrorDelta`.
     *
     * anyMass/rankMass correction: each redistributed combo removes exactly one enchant, so enchant
     * `e` appears in (nOutcomes - 1) of them — except the guaranteed enchant, whose removal outcomes
     * were filtered out by removeAdditional, so it appears in all nOutcomes.
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

        const redistributed = ComboUtils.removeAdditional(packedChosen, guaranteedFirstId, indexToEnchant);
        const nOutcomes = redistributed.length;
        
        // Zero-allocation equal split for Honest Accounting
        let quotient = 0n;
        let splitRemainder = prob;
        if (nOutcomes > 0) {
            const bigN = BigInt(nOutcomes);
            quotient = prob / bigN;
            splitRemainder = prob % bigN;
        }
        const settledMass = prob - splitRemainder;

        for (let i = 0; i < nOutcomes; i++) {
            ProbUtils.addItemMass(results, redistributed[i], quotient);
        }
        // Attributing total redistribution remainder to the first outcome to keep it in 'resolved' mass
        if (nOutcomes > 0 && splitRemainder > 0n) {
            ProbUtils.addItemMass(results, redistributed[0], splitRemainder);
        }

        const finalCount = currentCount - 1;
        ProbUtils.addItemMass(countMass, finalCount, prob); // Total mass settled into the N-1 count bucket

        for (const e of originalEnchants) {
            const id = ComboUtils.getEnchantId(e);
            const isGuaranteed = guaranteedFirstId !== null && id === guaranteedFirstId;
            const nSurvivors = isGuaranteed ? nOutcomes : nOutcomes - 1;
            
            // Precise survivor mass: (prob * count) / total using Banker's Rounding
            const survivorMass = ProbUtils.roundScale(prob, BigInt(nSurvivors), BigInt(nOutcomes));
            const loss = prob - survivorMass;
            if (loss > 0n) {
                ProbUtils.addItemMass(anyMass, id, -loss);
                ProbUtils.addItemMass(rankMass, e, -loss);
            }
        }

        return { rem: 0n }; // Remainder was attributed to the first outcome
    }

    private static processInitialNode(
        registry: RegistryState,
        currentProb: bigint,
        currentMeta: bigint,
        modLevel: number,
        guaranteedId: number | null,
        pool: PackedEnchant[],
        weights: number[],
        totalWeight: number,
        queue: SearchHeap,
        anyMass: BigUint64Array,
        rankMass: BigUint64Array,
        accountant: MassAccountant,
        timing?: SearchTiming
    ): void {

        const { enchantToIndex } = registry;
        let startDist = 0;
        if (timing) startDist = performance.now();
        const splitRemainder = ProbUtils.distributeDetailed(currentProb, weights, totalWeight, SearchService._splitsBuffer);
        const splits = SearchService._splitsBuffer;
        if (timing) timing.distributionMs += performance.now() - startDist;

        let startHeap = 0;
        if (timing) startHeap = performance.now();
        for (let i = 0; i < pool.length; i++) {
            const pNext = splits[i];
            const nextId = ComboUtils.getEnchantId(pool[i]);
            const nextMeta = ((1n << BigInt(nextId)) << 8n) | BigInt(modLevel);
            const nextPacked = ComboUtils.pack([pool[i]], guaranteedId, enchantToIndex);

            ProbUtils.addItemMass(anyMass, nextId, pNext);
            ProbUtils.addItemMass(rankMass, pool[i], pNext);

            accountant.record('pending', pNext);
            queue.pushOrMerge(nextMeta, pNext, modLevel, nextPacked);
        }

        if (timing) timing.heapMs += performance.now() - startHeap;
        accountant.record('sieved', splitRemainder);
    }
}
