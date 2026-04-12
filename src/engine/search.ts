import { SearchHeap } from '../utils/collections/SearchHeap.js';
import { PRECISION, ProbUtils, ComboUtils, LRUCache, AsyncUtils } from '../utils/index.js';
import { getEligiblePool } from '../core/registry.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { PackedCombo, PackedEnchant, SearchFrontier, RegistryState, EngineInstrumentation, MassCheckpoint, EngineExitReason, SearchTiming } from '../types/index.js';
import { FrontierFactory } from './frontier.js';
import { MassAccountant } from './MassAccountant.js';
import { ResidualMassHarvester } from './ResidualMassHarvester.js';
import { DistributionPool } from './DistributionPool.js';


/**
 * Service for the Best-First search of enchantment combinations.
 */
export class SearchService {
    public static readonly PROB_CONTINUE_TABLE: bigint[] = Array.from({ length: 65 }, (_, ml) => {
        const val = Math.min((ml + 1) / ENGINE_DEFAULTS.MAX_MODIFIED_LEVEL_FOR_CONTINUING, 1.0);
        return ProbUtils.toBigInt(val);
    });

    public static readonly CHECKPOINT_TARGETS: bigint[] = [
        0.1, 0.25, 0.5, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99, 0.999
    ].map(t => ProbUtils.toBigInt(t));

    public static getBitsetFromMeta(meta: bigint): bigint {
        return meta >> 8n;
    }

    public static getLevelFromMeta(meta: bigint): number {
        return Number(meta & 0xFFn);
    }

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
        const guaranteedFirstId = FrontierFactory.getGuaranteedFirstId(registry, guaranteedFirst);
        const initialPool = getEligiblePool(registry, cat, modLevel, poolCache);
        const poolWeights = initialPool.map(e => registry.weightMap[e >> 8]);
        const initialTotalWeight = poolWeights.reduce((a, b) => a + b, 0);

        const ctx: import('../types/engine.js').ForwardingContext = {
            registry,
            harvester: frontier.harvester,
            results,
            queue,
            anyMass: frontier.anyMass,
            rankMass: frontier.rankMass,
            countMass: frontier.countMass,
            resultsLimit,
            accountant,
            instrumentation,
            timing: timing ? { ...timing } : undefined,
            cat,
            guaranteedFirstId,
            pool: initialPool,
            poolWeights,
            initialTotalWeight
        };

        let iterations = 0;
        const expandedIds = new Set<bigint>();
        let redundantExpansions = 0;

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
                harvester: new ResidualMassHarvester(),
                checkpoints: [],
                exitReason: 'empty'
            };
        }

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
            
            if (!SearchService.withTiming(timing, 'heapMs', () => queue.popFast(current))) break;

            if (expandedIds.has(current.meta)) {
                redundantExpansions++;
            } else {
                expandedIds.add(current.meta);
            }

            accountant.subtract('pending', current.prob);
            const currentCount = ComboUtils.getCount(current.combo);

            SearchService.withTiming(timing, 'searchMs', () => {
                if (currentCount === 0) {
                    this.processInitialNode(current.prob, current.meta, modLevel, ctx);
                } else {
                    this.processSearchNode(current.prob, current.meta, current.combo, currentCount, ctx);
                }
            });

            // Checkpoints: record after processing — current.prob is the minimum threshold
            // needed to have processed this node (and thus reached this mass coverage).
            const bk = accountant.getBookkeeping();
            while (checkpointIdx < SearchService.CHECKPOINT_TARGETS.length) {
                const targetMass = SearchService.CHECKPOINT_TARGETS[checkpointIdx];
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
        currentProb: bigint,
        currentMeta: bigint,
        currentCombo: number,
        currentCount: number,
        ctx: import('../types/engine.js').ForwardingContext
    ): void {

        const { registry, harvester, timing, cat, pool } = ctx;
        const { indexToEnchant } = registry;
        const currentBitset = SearchService.getBitsetFromMeta(currentMeta);
        const currentLevel = SearchService.getLevelFromMeta(currentMeta);
        const isBook = cat === "book";

        const currentEnchants = (isBook && currentCount > 1)
            ? ComboUtils.unpack(currentCombo, indexToEnchant)
            : [] as PackedEnchant[];

        const probContinue = (isBook && !registry.multiEnchantBooks && currentCount >= 1)
            ? 0n
            : (SearchService.PROB_CONTINUE_TABLE[currentLevel] || 0n);

        if (!harvester.has(currentMeta)) {
            SearchService.withTiming(timing, 'filteringMs', () => {
                const tempEligible = new Int32Array(pool.length);
                const tempWeights = new Int32Array(pool.length);
                let eligibleCount = 0;
                let totalWeight = 0;

                for (let i = 0; i < pool.length; i++) {
                    const e = pool[i];
                    const id = ComboUtils.getEnchantId(e);
                    if ((currentBitset & (1n << BigInt(id))) !== 0n) continue;
                    if ((currentBitset & registry.conflictBitsets[id]) !== 0n) continue;
                    tempEligible[eligibleCount] = e;
                    tempWeights[eligibleCount] = ctx.poolWeights[i];
                    eligibleCount++;
                    totalWeight += ctx.poolWeights[i];
                }
                
                const nextLevel = currentCount >= 1 ? Math.floor(currentLevel / 2) : currentLevel;
                const blueprint: import('../types/engine.js').ExpansionBlueprint = {
                    probContinue,
                    totalWeight,
                    eligibleCount,
                    eligibleEnchants: tempEligible.slice(0, eligibleCount),
                    eligibleWeights: tempWeights.slice(0, eligibleCount),
                    nextLevel,
                    currentCount,
                    currentCombo,
                    currentEnchants,
                    residue: 0n
                };
                harvester.registerExpansion(currentMeta, blueprint);
            });
        }

        harvester.forwardMass(
            currentProb, currentMeta, currentCombo, ctx
        );
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
        currentCombo: number,
        hasCombo: boolean,
        multiEnchantBooks: boolean,
        floor: bigint
    ): { isLimitReached: boolean; isTooSmall: boolean; isMapFull: boolean; isTerminal: boolean } {
        const isLimitReached = currentCount >= (isBook && !multiEnchantBooks ? 1 : ENGINE_DEFAULTS.MAX_ENCHANTS_PER_ITEM);
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
        currentProb: bigint,
        currentMeta: bigint,
        currentLevel: number,
        ctx: import('../types/engine.js').ForwardingContext
    ): void {
        const { registry, timing, accountant, queue, guaranteedFirstId, pool, poolWeights, initialTotalWeight } = ctx;
        const { enchantToIndex } = registry;
        
        const splits = SearchService.withTiming(timing, 'distributionMs', () => {
            const buffer = DistributionPool.getBuffer(0);
            const splitRemainder = ProbUtils.distributeDetailed(currentProb, poolWeights, initialTotalWeight, buffer);
            accountant.record('sieved', splitRemainder);
            return buffer;
        });

        SearchService.withTiming(timing, 'heapMs', () => {
            for (let i = 0; i < pool.length; i++) {
                const pNext = splits[i];
                if (pNext === 0n) continue;
                
                const nextId = ComboUtils.getEnchantId(pool[i]);
                const nextMeta = ((1n << BigInt(nextId)) << 8n) | BigInt(currentLevel);
                const nextPacked = ComboUtils.pack([pool[i]], guaranteedFirstId, enchantToIndex);

                ProbUtils.addItemMass(ctx.anyMass, nextId, pNext);
                ProbUtils.addItemMass(ctx.rankMass, pool[i], pNext);

                accountant.record('pending', pNext);
                queue.pushOrMerge(nextMeta, pNext, currentLevel, nextPacked);
            }
        });
    }
}
