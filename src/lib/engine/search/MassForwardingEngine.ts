import { ENGINE_LIMITS, SEARCH_CONSTANTS } from '#constants/engine.js';
import { DistributionBufferPool } from '#engine/distribution/DistributionBufferPool.js';
import { SearchProcessor, type SettlementMassResult } from '#engine/search/SearchProcessor.js';
import { SearchNodeGraph } from '#engine/search/SearchNodeGraph.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { ExpansionBlueprint, ForwardingContext, PackedCombo } from '#types/index.js';
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
            const stopIsClueCompatible = this.isClueCompatible(blueprint.currentCombo, ctx);

            const stopSettlement = stopIsClueCompatible
                ? SearchProcessor.settleMass(
                    ctx.cat === "book",
                    blueprint.currentCount,
                    blueprint.currentCombo,
                    probStop,
                    ctx.results,
                    ctx.cluePolicy,
                    ctx.registry.indexToEnchant
                )
                : MassForwardingEngine.emptySettlement();

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
                    stopSettlement,
                    scaleLoss,
                    stopIsClueCompatible,
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
                stopSettlement,
                scaleLoss,
                stopIsClueCompatible,
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
        stopSettlement: SettlementMassResult,
        scaleLoss: bigint,
        stopIsClueCompatible: boolean,
        blueprint: ExpansionBlueprint,
        term: { isLimitReached: boolean; isTooSmall: boolean; isMapFull: boolean },
        ctx: ForwardingContext,
        tracker: SearchStateTracker
    ): bigint {
        const forwardSettlement = stopIsClueCompatible
            ? SearchProcessor.settleMass(
                ctx.cat === "book",
                blueprint.currentCount,
                blueprint.currentCombo,
                probForward,
                ctx.results,
                ctx.cluePolicy,
                ctx.registry.indexToEnchant
            )
            : MassForwardingEngine.emptySettlement();

        const localRounding = stopSettlement.rounding + forwardSettlement.rounding + scaleLoss;
        const stopSettled = this.settledMass(probStop, stopSettlement);
        const forwardSettled = this.settledMass(probForward, forwardSettlement);

        if (stopIsClueCompatible) {
            tracker.mass.record('resolved', stopSettled);
            tracker.mass.record('sieved', stopSettlement.discarded);
        } else {
            tracker.mass.record('sieved', probStop);
        }
        tracker.mass.record('rounding', localRounding);

        if (!stopIsClueCompatible) {
            tracker.mass.record('sieved', probForward);
        } else if (term.isTooSmall) {
            if (ctx.instrumentation) ctx.instrumentation.totalPrunedNodes++;
            tracker.mass.record('sieved', probForward - forwardSettlement.rounding);
        } else if (term.isLimitReached) {
            tracker.mass.record('overflow', probForward - forwardSettlement.rounding);
        } else if (term.isMapFull) {
            tracker.mass.record('capped', probForward - forwardSettlement.rounding);
        } else if (blueprint.totalWeight === 0) {
            tracker.mass.record('resolved', forwardSettled);
            tracker.mass.record('sieved', forwardSettlement.discarded);
        }

        if (localRounding > 0n && ctx.instrumentation) ctx.instrumentation.roundingErrorEvents++;
        return (stopIsClueCompatible ? stopSettled : 0n) + (blueprint.totalWeight === 0 ? forwardSettled : 0n);
    }

    private static processExpansionStep(
        nodeId: number,
        probStop: bigint,
        probForward: bigint,
        stopSettlement: SettlementMassResult,
        scaleLoss: bigint,
        stopIsClueCompatible: boolean,
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
            if (childId === SearchNodeGraph.PRUNED_CHILD_ID) {
                tracker.mass.record('sieved', pNext);
                if (ctx.instrumentation) ctx.instrumentation.totalPrunedNodes++;
                continue;
            }

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

        if (stopIsClueCompatible) {
            tracker.mass.record('resolved', this.settledMass(probStop, stopSettlement));
            tracker.mass.record('sieved', stopSettlement.discarded);
        } else {
            tracker.mass.record('sieved', probStop);
        }
        tracker.mass.record('rounding', stopSettlement.rounding + scaleLoss);

        return stopIsClueCompatible ? this.settledMass(probStop, stopSettlement) : 0n;
    }

    private static isClueCompatible(combo: PackedCombo, ctx: ForwardingContext): boolean {
        return ctx.cluePolicy?.containsTargetClue(combo, ctx.registry.indexToEnchant) ?? true;
    }

    private static emptySettlement(): SettlementMassResult {
        return { rounding: 0n, discarded: 0n };
    }

    private static settledMass(prob: bigint, settlement: SettlementMassResult): bigint {
        return prob - settlement.rounding - settlement.discarded;
    }
}
