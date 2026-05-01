import { MassBookkeeping, MassAccounting, MassEventType } from '#types/mass.js';
import { ExpansionBlueprint, ForwardingContext, PackedCombo } from '#types/index.js';
import { ProbUtils, ComboUtils, PRECISION } from '#utils/index.js';

import { DistributionBufferPool } from '#engine/distribution/DistributionBufferPool.js';
import { ENGINE_LIMITS, SEARCH_CONSTANTS, BIGINT_CONSTANTS } from '#constants/engine.js';
import { ProbabilityMassBookkeeper } from '#engine/search/ProbabilityMassBookkeeper.js';

/**
 * Unified state tracker for probability mass and expanded node blueprints.
 * Facilitates high-speed forwarding through cached search subtrees.
 */
export class SearchStateTracker {
    private static readonly MAX_RECURSION_DEPTH = SEARCH_CONSTANTS.MAX_RECURSION_DEPTH;
    
    private readonly accountant: ProbabilityMassBookkeeper;
    private readonly expansionCache: Map<bigint, ExpansionBlueprint>;

    constructor(initialMass?: MassBookkeeping, initialCache?: Map<bigint, ExpansionBlueprint>) {
        this.accountant = new ProbabilityMassBookkeeper(initialMass);
        this.expansionCache = initialCache || new Map();
    }

    public record(type: MassEventType, prob: bigint): void {
        this.accountant.record(type, prob);
    }

    public subtract(type: MassEventType, prob: bigint): void {
        this.accountant.subtract(type, prob);
    }

    public addScaled(other: SearchStateTracker, factor: bigint): void {
        this.accountant.addScaled(other.accountant, factor);
    }

    public getTotalMass(): bigint {
        return this.accountant.getTotalMass();
    }

    public getBookkeeping(): MassBookkeeping {
        return this.accountant.getBookkeeping();
    }

    public toPublic(): MassAccounting {
        return this.accountant.toPublic();
    }

    /**
     * Returns the mass from generation paths that reached a valid leaf state.
     */
    public getResolvedMass(): bigint {
        return this.accountant.getResolvedMass();
    }

    /**
     * Returns the mass from frontiers that were discovered but not yet expanded.
     */
    public getUnexploredMass(): bigint {
        return this.accountant.getUnexploredMass();
    }

    /**
     * Returns the mass that was intentionally pruned or discarded due to technical limits.
     */
    public getDiscardedMass(): bigint {
        return this.accountant.getDiscardedMass();
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
            withTiming: <T>(timing: any, bucket: any, fn: () => T) => T;
            settleMass: (...args: any[]) => bigint;
            isTerminalCondition: (...args: any[]) => any;
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

            const { registry, timing, cat } = ctx;
            const currentBitset = meta >> BIGINT_CONSTANTS.ENCHANT_SHIFT;
            const probContinue = blueprint.probContinue;
            
            // Split mass into stop vs forward
            const { probStop, probForward, scaleLoss } = searchProcessor.withTiming(timing, 'settlingMs', () => {
                const pStop = ProbUtils.scale(incomingMass, (PRECISION - probContinue));
                const pForward = ProbUtils.scale(incomingMass, probContinue);
                const loss = incomingMass - (pStop + pForward);
                return { probStop: pStop, probForward: pForward, scaleLoss: loss };
            });

            const remStop = searchProcessor.withTiming(timing, 'settlingMs', () => 
                searchProcessor.settleMass(
                    cat === "book", blueprint.currentCount, blueprint.currentCombo, blueprint.currentEnchants, 
                    probStop, ctx.results
                )
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
            withTiming: <T>(timing: any, bucket: string, fn: () => T) => T;
            settleMass: (...args: any[]) => bigint;
        }
    ): bigint {
        const { timing, cat, instrumentation } = ctx;
        
        const remForward = searchProcessor.withTiming(timing, 'settlingMs', () => 
            searchProcessor.settleMass(
                cat === "book", blueprint.currentCount, blueprint.currentCombo, blueprint.currentEnchants, 
                probForward, ctx.results
            )
        );

        const localRounding = remStop + remForward + scaleLoss;
        
        this.accountant.record('resolved', probStop - remStop);
        this.accountant.record('rounding', localRounding);
        
        if (term.isTooSmall) {
            if (instrumentation) instrumentation.totalPrunedNodes++;
            this.accountant.record('sieved', probForward - remForward);
        } else if (term.isLimitReached) {
            this.accountant.record('overflow', probForward - remForward);
        } else if (term.isMapFull) {
            this.accountant.record('capped', probForward - remForward);
        } else if (blueprint.totalWeight === 0) {
            this.accountant.record('resolved', probForward - remForward);
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
        this.accountant.record('rounding', individualRemainder);

        const { recovered } = ProbUtils.distributeWithResidue(
            probForward, blueprint.eligibleWeights, blueprint.totalWeight, splits, blueprint, eligibleCount
        );

        if (recovered > 0n) {
            this.accountant.subtract('rounding', recovered);
            this.accountant.record('recoveredRounding', recovered);
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
                this.accountant.record('pending', pNext);
                queue.pushOrMerge(nextMeta, pNext, nextPacked);
            }
        }

        this.accountant.record('resolved', probStop - remStop);
        this.accountant.record('rounding', remStop + scaleLoss);
        
        return (probStop - remStop);
    }

    public clone(): SearchStateTracker {
        return new SearchStateTracker(this.getBookkeeping(), new Map(this.expansionCache));
    }
}
