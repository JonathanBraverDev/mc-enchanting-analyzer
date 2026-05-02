import { ENGINE_LIMITS, SEARCH_CONSTANTS } from '#constants/engine.js';
import { DistributionBufferPool } from '#engine/distribution/DistributionBufferPool.js';
import { SearchProcessor } from '#engine/search/SearchProcessor.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { ExpansionBlueprint, ForwardingContext, PackedCombo } from '#types/index.js';
import { ProbUtils, PRECISION } from '#utils/index.js';

interface ForwardingNodeRequest {
    currentProb: bigint;
    currentMeta: bigint;
    currentCombo: PackedCombo;
    currentCount: number;
    modLevel: number;
    ctx: ForwardingContext;
    tracker: SearchStateTracker;
}

interface ForwardingStackEntry {
    mass: bigint;
    meta: bigint;
    depth: number;
}

/**
 * Executes probability mass forwarding through cached expansion blueprints.
 */
export class MassForwardingEngine {
    private static readonly MAX_RECURSION_DEPTH = SEARCH_CONSTANTS.MAX_RECURSION_DEPTH;

    public static forwardNode(request: ForwardingNodeRequest): void {
        const { currentProb, currentMeta, currentCombo, currentCount, modLevel, ctx, tracker } = request;

        if (currentCount === 0) {
            SearchProcessor.processInitialNode(currentProb, modLevel, ctx, tracker);
            return;
        }

        if (!tracker.has(currentMeta)) {
            tracker.registerExpansion(
                currentMeta,
                SearchProcessor.buildExpansionBlueprint(currentMeta, currentCombo, currentCount, ctx)
            );
        }

        this.forwardMass(currentProb, currentMeta, ctx, tracker);
    }

    public static forwardMass(
        initialMass: bigint,
        initialMeta: bigint,
        ctx: ForwardingContext,
        tracker: SearchStateTracker
    ): bigint {
        const stack: ForwardingStackEntry[] = [
            { mass: initialMass, meta: initialMeta, depth: 0 }
        ];

        let totalResolvedFromTrees = 0n;

        while (stack.length > 0) {
            const { mass: incomingMass, meta, depth } = stack.pop()!;

            const blueprint = tracker.get(meta);
            if (!blueprint) continue;

            const probContinue = blueprint.probContinue;
            const probStop = ProbUtils.scale(incomingMass, (PRECISION - probContinue));
            const probForward = ProbUtils.scale(incomingMass, probContinue);
            const scaleLoss = incomingMass - (probStop + probForward);

            const remStop = SearchProcessor.settleMass(
                ctx.cat === "book",
                blueprint.currentCount,
                blueprint.currentCombo,
                blueprint.currentEnchants,
                probStop,
                ctx.results
            );

            const term = SearchProcessor.isTerminalCondition(
                blueprint.currentCount,
                ctx.cat === "book",
                probForward,
                ctx.results.size,
                ctx.resultsLimit,
                ctx.results.has(blueprint.currentCombo),
                ctx.registry.multiEnchantBooks,
                ProbUtils.toBigInt(ENGINE_LIMITS.SYSTEM_THRESHOLD_FLOOR)
            );

            if (term.isTerminal || blueprint.totalWeight === 0) {
                totalResolvedFromTrees += this.handleTerminal(
                    probStop,
                    probForward,
                    remStop,
                    scaleLoss,
                    blueprint,
                    term,
                    ctx,
                    tracker
                );
                continue;
            }

            totalResolvedFromTrees += this.processExpansionStep(
                meta,
                probStop,
                probForward,
                remStop,
                scaleLoss,
                blueprint,
                ctx,
                tracker,
                depth,
                stack
            );
        }

        return totalResolvedFromTrees;
    }

    private static handleTerminal(
        probStop: bigint,
        probForward: bigint,
        remStop: bigint,
        scaleLoss: bigint,
        blueprint: ExpansionBlueprint,
        term: { isLimitReached: boolean; isTooSmall: boolean; isMapFull: boolean },
        ctx: ForwardingContext,
        tracker: SearchStateTracker
    ): bigint {
        const remForward = SearchProcessor.settleMass(
            ctx.cat === "book",
            blueprint.currentCount,
            blueprint.currentCombo,
            blueprint.currentEnchants,
            probForward,
            ctx.results
        );

        const localRounding = remStop + remForward + scaleLoss;

        tracker.mass.record('resolved', probStop - remStop);
        tracker.mass.record('rounding', localRounding);

        if (term.isTooSmall) {
            if (ctx.instrumentation) ctx.instrumentation.totalPrunedNodes++;
            tracker.mass.record('sieved', probForward - remForward);
        } else if (term.isLimitReached) {
            tracker.mass.record('overflow', probForward - remForward);
        } else if (term.isMapFull) {
            tracker.mass.record('capped', probForward - remForward);
        } else if (blueprint.totalWeight === 0) {
            tracker.mass.record('resolved', probForward - remForward);
        }

        if (localRounding > 0n && ctx.instrumentation) ctx.instrumentation.roundingErrorEvents++;
        return (probStop - remStop) + (blueprint.totalWeight === 0 ? (probForward - remForward) : 0n);
    }

    private static processExpansionStep(
        meta: bigint,
        probStop: bigint,
        probForward: bigint,
        remStop: bigint,
        scaleLoss: bigint,
        blueprint: ExpansionBlueprint,
        ctx: ForwardingContext,
        tracker: SearchStateTracker,
        depth: number,
        stack: ForwardingStackEntry[]
    ): bigint {
        const eligibleCount = blueprint.eligibleCount;
        const splits = DistributionBufferPool.getBuffer(depth);

        const individualRemainder = probForward % BigInt(blueprint.totalWeight);
        tracker.mass.record('rounding', individualRemainder);

        const { recovered } = ProbUtils.distributeWithResidue(
            probForward,
            blueprint.eligibleWeights,
            blueprint.totalWeight,
            splits,
            tracker.getForwardingResidue(meta),
            eligibleCount
        );

        if (recovered > 0n) {
            tracker.mass.subtract('rounding', recovered);
            tracker.mass.record('recoveredRounding', recovered);
            if (ctx.instrumentation) ctx.instrumentation.roundingErrorEvents++;
        }

        const childMetas = blueprint.childMetas;
        const childPackedCombos = blueprint.childPackedCombos;

        for (let i = 0; i < eligibleCount; i++) {
            const pNext = splits[i];
            if (pNext === undefined || pNext === 0n) continue;

            const nextMeta = childMetas[i]!;
            const nextPacked = childPackedCombos[i]! as PackedCombo;

            // If the child is cached but we've reached max stack depth, fall back to the main queue
            // rather than recursing further. Mass is not lost: it enters pending and the main search
            // loop will re-process it through the same cache fast-path next iteration.
            if (tracker.has(nextMeta) && depth < MassForwardingEngine.MAX_RECURSION_DEPTH) {
                stack.push({ mass: pNext, meta: nextMeta, depth: depth + 1 });
            } else {
                tracker.mass.record('pending', pNext);
                ctx.queue.pushOrMerge(nextMeta, pNext, nextPacked);
            }
        }

        tracker.mass.record('resolved', probStop - remStop);
        tracker.mass.record('rounding', remStop + scaleLoss);

        return probStop - remStop;
    }
}
