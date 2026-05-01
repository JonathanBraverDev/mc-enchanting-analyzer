import { MassBookkeeping } from '#types/mass.js';
import { ExpansionBlueprint, ForwardingContext, PackedCombo, PackedEnchant, SearchState } from '#types/index.js';
import { ProbUtils, ComboUtils, PRECISION } from '#utils/index.js';

import { DistributionBufferPool } from '#engine/distribution/DistributionBufferPool.js';
import { ENGINE_LIMITS, SEARCH_CONSTANTS, BIGINT_CONSTANTS } from '#constants/engine.js';
import { ProbabilityMassAccountant } from '#engine/search/ProbabilityMassAccountant.js';
import { SearchHeap } from '#utils/collections/SearchHeap.js';

/**
 * Unified state accountant for probability mass and expanded node blueprints.
 * Facilitates high-speed forwarding through cached search subtrees.
 */
export class SearchStateTracker {
    private static readonly MAX_RECURSION_DEPTH = SEARCH_CONSTANTS.MAX_RECURSION_DEPTH;

    public readonly mass: ProbabilityMassAccountant;
    private readonly expansionCache: Map<bigint, ExpansionBlueprint>;

    constructor(initialMass?: MassBookkeeping, initialCache?: Map<bigint, ExpansionBlueprint>) {
        this.mass = new ProbabilityMassAccountant(initialMass);
        this.expansionCache = initialCache || new Map();
    }

    /**
     * Initializes a new SearchState or clones an existing one.
     * Replaces the legacy StateFactory.
     */
    public static createState(
        modLevel: number,
        existing?: SearchState,
        threshold: bigint = 0n
    ): SearchState {
        if (existing) {
            return {
                queue: existing.queue.clone(),
                results: new Map(existing.results),
                tracker: existing.tracker.clone(),
                threshold,
                // iterations resets each run so SearchController can enforce per-run limits;
                // nodesProcessed is cumulative across all tiers and used for diagnostics only.
                iterations: 0,
                nodesProcessed: existing.nodesProcessed,
                checkpoints: []
            };
        }

        const results = new Map<PackedCombo, bigint>();
        const queue = new SearchHeap();

        // Always start from an empty generation state (0 packed, 0 bitset)
        const initialPacked = 0 as PackedCombo;
        const initialBitset = 0n;

        queue.pushOrMerge((initialBitset << 8n) | BigInt(modLevel), PRECISION, initialPacked);

        return {
            queue, results,
            tracker: new SearchStateTracker({
                resolved: 0n,
                pending: PRECISION,
                sieved: 0n,
                overflow: 0n,
                capped: 0n,
                rounding: 0n,
                recoveredRounding: 0n,
                recoveredSieved: 0n,
                clueKnownSpace: 0n
            }),
            threshold,
            iterations: 0,
            nodesProcessed: 0,
            checkpoints: []
        };
    }

    // --- Expansion Caching ---

    public registerExpansion(key: bigint, blueprint: ExpansionBlueprint): void {
        this.expansionCache.set(key, blueprint);
    }

    public has(key: bigint): boolean {
        return this.expansionCache.has(key);
    }

    public get(key: bigint): ExpansionBlueprint | undefined {
        return this.expansionCache.get(key);
    }

    public getCacheSize(): number {
        return this.expansionCache.size;
    }

    // --- Mass Forwarding ---

    /**
     * Forwards probability mass to cached children, bypassing the priority queue.
     * Uses an iterative stack-based approach to maintain linear memory flow.
     */
    public forwardMass(
        initialMass: bigint,
        initialMeta: bigint,
        initialCombo: PackedCombo,
        ctx: ForwardingContext,
        searchProcessor: {
            settleMass: (isBook: boolean, currentCount: number, packedChosen: PackedCombo, currentEnchants: PackedEnchant[], prob: bigint, results: Map<PackedCombo, bigint>) => bigint;
            isTerminalCondition: (currentCount: number, isBook: boolean, probForward: bigint, resultsSize: number, resultsLimit: number, hasCombo: boolean, multiEnchantBooks: boolean, floor: bigint) => { isLimitReached: boolean; isTooSmall: boolean; isMapFull: boolean; isTerminal: boolean };
        }
    ): bigint {
        const stack: Array<{ mass: bigint, meta: bigint, combo: PackedCombo, depth: number }> = [
            { mass: initialMass, meta: initialMeta, combo: initialCombo, depth: 0 }
        ];

        let totalResolvedFromTrees = 0n;

        while (stack.length > 0) {
            const { mass: incomingMass, meta, depth } = stack.pop()! ;

            const blueprint = this.expansionCache.get(meta);
            if (!blueprint) continue;

            const { registry, cat } = ctx;
            const currentBitset = meta >> BIGINT_CONSTANTS.ENCHANT_SHIFT;
            const probContinue = blueprint.probContinue;

            // Split mass into stop vs forward
            const probStop = ProbUtils.scale(incomingMass, (PRECISION - probContinue));
            const probForward = ProbUtils.scale(incomingMass, probContinue);
            const scaleLoss = incomingMass - (probStop + probForward);

            const remStop = searchProcessor.settleMass(
                cat === "book", blueprint.currentCount, blueprint.currentCombo, blueprint.currentEnchants,
                probStop, ctx.results
            );

            // Terminal Check
            const term = searchProcessor.isTerminalCondition(
                blueprint.currentCount, cat === "book", probForward, ctx.results.size, ctx.resultsLimit,
                ctx.results.has(blueprint.currentCombo), registry.multiEnchantBooks,
                ProbUtils.toBigInt(ENGINE_LIMITS.SYSTEM_THRESHOLD_FLOOR) // SYSTEM_THRESHOLD_FLOOR
            );

            if (term.isTerminal || blueprint.totalWeight === 0) {
                totalResolvedFromTrees += this.handleTerminal(incomingMass, probStop, probForward, remStop, scaleLoss, blueprint, term, ctx, searchProcessor);
                continue;
            }

            // Standard expansion path
            const resolvedSub = this.processExpansionStep(probStop, probForward, remStop, scaleLoss, currentBitset, blueprint, ctx, depth, stack);
            totalResolvedFromTrees += resolvedSub;
        }

        return totalResolvedFromTrees;
    }

    private handleTerminal(
        _incomingMass: bigint,
        probStop: bigint,
        probForward: bigint,
        remStop: bigint,
        scaleLoss: bigint,
        blueprint: ExpansionBlueprint,
        term: { isLimitReached: boolean; isTooSmall: boolean; isMapFull: boolean },
        ctx: ForwardingContext,
        searchProcessor: {
            settleMass: (isBook: boolean, currentCount: number, packedChosen: PackedCombo, currentEnchants: PackedEnchant[], prob: bigint, results: Map<PackedCombo, bigint>) => bigint;
        }
    ): bigint {
        const { cat, instrumentation } = ctx;

        const remForward = searchProcessor.settleMass(
            cat === "book", blueprint.currentCount, blueprint.currentCombo, blueprint.currentEnchants,
            probForward, ctx.results
        );

        const localRounding = remStop + remForward + scaleLoss;

        this.mass.record('resolved', probStop - remStop);
        this.mass.record('rounding', localRounding);

        if (term.isTooSmall) {
            if (instrumentation) instrumentation.totalPrunedNodes++;
            this.mass.record('sieved', probForward - remForward);
        } else if (term.isLimitReached) {
            this.mass.record('overflow', probForward - remForward);
        } else if (term.isMapFull) {
            this.mass.record('capped', probForward - remForward);
        } else if (blueprint.totalWeight === 0) {
            this.mass.record('resolved', probForward - remForward);
        }

        if (localRounding > 0n && instrumentation) instrumentation.roundingErrorEvents++;
        return (probStop - remStop) + (blueprint.totalWeight === 0 ? (probForward - remForward) : 0n);
    }

    private processExpansionStep(
        probStop: bigint,
        probForward: bigint,
        remStop: bigint,
        scaleLoss: bigint,
        currentBitset: bigint,
        blueprint: ExpansionBlueprint,
        ctx: ForwardingContext,
        depth: number,
        stack: Array<{ mass: bigint, meta: bigint, combo: PackedCombo, depth: number }>
    ): bigint {
        const { registry, instrumentation, queue } = ctx;

        const eligibleCount = blueprint.eligibleCount;
        const splits = DistributionBufferPool.getBuffer(depth);

        const individualRemainder = probForward % BigInt(blueprint.totalWeight);
        this.mass.record('rounding', individualRemainder);

        const { recovered } = ProbUtils.distributeWithResidue(
            probForward, blueprint.eligibleWeights, blueprint.totalWeight, splits, blueprint, eligibleCount
        );

        if (recovered > 0n) {
            this.mass.subtract('rounding', recovered);
            this.mass.record('recoveredRounding', recovered);
            if (instrumentation) instrumentation.roundingErrorEvents++;
        }

        for (const [i, e] of blueprint.eligibleEnchants.entries()) {
            if (i >= eligibleCount) break;
            const pNext = splits[i];
            if (pNext === undefined || pNext === 0n) continue;

            const nextPacked = ComboUtils.packAppend(blueprint.currentCombo, e, registry.enchantToIndex) as PackedCombo;
            const nextId = ComboUtils.getEnchantId(e);
            const nextMeta = ((currentBitset | BIGINT_CONSTANTS.ID_BIT_LOOKUP[nextId]!) << BIGINT_CONSTANTS.ENCHANT_SHIFT) | BIGINT_CONSTANTS.LEVEL_LOOKUP[blueprint.nextLevel]!;

            // If the child is cached but we've reached max stack depth, fall back to the main queue
            // rather than recursing further. Mass is not lost — it enters 'pending' and the main
            // search loop will re-process it through the same cache fast-path next iteration.
            if (this.expansionCache.has(nextMeta) && depth < SearchStateTracker.MAX_RECURSION_DEPTH) {
                stack.push({ mass: pNext, meta: nextMeta, combo: nextPacked, depth: depth + 1 });
            } else {
                this.mass.record('pending', pNext);
                queue.pushOrMerge(nextMeta, pNext, nextPacked);
            }
        }

        this.mass.record('resolved', probStop - remStop);
        this.mass.record('rounding', remStop + scaleLoss);

        return (probStop - remStop);
    }

    public clone(): SearchStateTracker {
        return new SearchStateTracker(this.mass.getBookkeeping(), new Map(this.expansionCache));
    }
}
