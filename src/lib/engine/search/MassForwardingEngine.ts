import { ENGINE_LIMITS, SEARCH_CONSTANTS } from '#constants/engine.js';
import { DistributionBufferPool } from '#engine/distribution/DistributionBufferPool.js';
import { SearchProcessor } from '#engine/search/SearchProcessor.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { ExpansionBlueprint, ForwardingContext } from '#types/index.js';
import { ProbUtils, PRECISION } from '#utils/index.js';

interface ForwardingNodeRequest {
    currentProb: bigint;
    nodeId: number;
    modLevel: number;
    ctx: ForwardingContext;
    tracker: SearchStateTracker;
}

interface ForwardingStackEntry {
    mass: bigint;
    nodeId: number;
    depth: number;
}

/**
 * Executes probability mass forwarding through cached expansion blueprints.
 */
export class MassForwardingEngine {
    private static readonly MAX_RECURSION_DEPTH = SEARCH_CONSTANTS.MAX_RECURSION_DEPTH;

    public static forwardNode(request: ForwardingNodeRequest): void {
        const { currentProb, nodeId, modLevel, ctx, tracker } = request;
        const currentCount = ctx.graph.getCount(nodeId);

        if (currentCount === 0) {
            SearchProcessor.processInitialNode(currentProb, modLevel, ctx, tracker);
            return;
        }

        if (!ctx.graph.hasBlueprint(nodeId)) {
            ctx.graph.setBlueprint(
                nodeId,
                SearchProcessor.buildExpansionBlueprint(nodeId, ctx)
            );
        }

        this.forwardMass(currentProb, nodeId, ctx, tracker);
    }

    public static forwardMass(
        initialMass: bigint,
        initialNodeId: number,
        ctx: ForwardingContext,
        tracker: SearchStateTracker
    ): bigint {
        const stack: ForwardingStackEntry[] = [
            { mass: initialMass, nodeId: initialNodeId, depth: 0 }
        ];

        let totalResolvedFromTrees = 0n;

        while (stack.length > 0) {
            const { mass: incomingMass, nodeId, depth } = stack.pop()!;

            const blueprint = ctx.graph.getBlueprint(nodeId);
            if (!blueprint) continue;

            const probContinue = blueprint.probContinue;
            const probStop = ProbUtils.scale(incomingMass, (PRECISION - probContinue));
            const probForward = ProbUtils.scale(incomingMass, probContinue);
            const scaleLoss = incomingMass - (probStop + probForward);

            const remStop = SearchProcessor.settleMass(
                ctx.cat === "book",
                blueprint.currentCount,
                blueprint.currentCombo,
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
                nodeId,
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
        nodeId: number,
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
        const edgeStart = blueprint.edgeStart;
        const splits = DistributionBufferPool.getBuffer(depth);

        const individualRemainder = probForward % BigInt(blueprint.totalWeight);
        tracker.mass.record('rounding', individualRemainder);

        const { recovered } = ProbUtils.distributeWithResidue(
            probForward,
            ctx.graph.getEdgeWeights(),
            blueprint.totalWeight,
            splits,
            ctx.graph.getForwardingResidue(nodeId),
            eligibleCount,
            edgeStart
        );

        if (recovered > 0n) {
            tracker.mass.subtract('rounding', recovered);
            tracker.mass.record('recoveredRounding', recovered);
            if (ctx.instrumentation) ctx.instrumentation.roundingErrorEvents++;
        }

        for (let i = 0; i < eligibleCount; i++) {
            const pNext = splits[i];
            if (pNext === undefined || pNext === 0n) continue;

            const childId = ctx.graph.getEdgeChildId(edgeStart + i);

            // If the child is cached but we've reached max stack depth, fall back to the main queue
            // rather than recursing further. Mass is not lost: it enters pending and the main search
            // loop will re-process it through the same cache fast-path next iteration.
            if (ctx.graph.hasBlueprint(childId) && depth < MassForwardingEngine.MAX_RECURSION_DEPTH) {
                stack.push({ mass: pNext, nodeId: childId, depth: depth + 1 });
            } else {
                tracker.mass.record('pending', pNext);
                ctx.queue.pushOrMerge(childId, pNext);
            }
        }

        tracker.mass.record('resolved', probStop - remStop);
        tracker.mass.record('rounding', remStop + scaleLoss);

        return probStop - remStop;
    }
}
