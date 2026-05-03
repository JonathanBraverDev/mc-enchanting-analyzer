import { AsyncUtils, ProbUtils } from '#utils/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { SearchState, SearchContext, ForwardingContext } from '#types/index.js';
import { MassForwardingEngine } from '#engine/search/MassForwardingEngine.js';

/**
 * Orchestrates the Best-First Search loop.
 */
export class SearchController {
    /**
     * Executes the search loop on the given state until a limit or threshold is reached.
     * This is the generic Best-First Search orchestrator, agnostic of Minecraft pooling details.
     *
     * @param state The current search state (queue, results, mass maps).
     * @param ctx Forwarding context for expansion.
     * @param modLevel The modified level context.
     * @param config Internal search configuration (threshold, limit, signal).
     */
    public static async run(
        state: SearchState,
        ctx: ForwardingContext,
        modLevel: number,
        config: SearchContext
    ): Promise<void> {
        const { queue, tracker, results } = state;
        const { threshold, limit, signal, instrumentation, timing } = config;

        let iterations = 0;
        let exploredSampleIdx = 0;
        const exploredTargets = instrumentation?.exploredMassTargets?.map(target => ({
            target,
            units: ProbUtils.toBigInt(target)
        })) ?? [];
        const current = { nodeId: 0, prob: 0n };

        let aggregateStart = performance.now();

        while (queue.size() > 0 && iterations < limit) {
            const nextProb = queue.peekProb();

            if (iterations > 0 && iterations % 1000 === 0) {
                if (timing) {
                    timing.searchMs = (timing.searchMs ?? 0) + performance.now() - aggregateStart;
                }
                if (instrumentation) {
                    instrumentation.queueSize = queue.size();
                    instrumentation.indexMapSize = queue.indexMapSize;
                    instrumentation.resultsSize = results.size;
                }
                await AsyncUtils.yield();
                if (timing) {
                    aggregateStart = performance.now();
                }
                if (signal?.aborted) {
                    state.exitReason = 'aborted';
                    break;
                }
            }

            if (nextProb < threshold) {
                state.exitReason = 'threshold';
                break;
            }

            if (queue.size() > ENGINE_LIMITS.MAX_QUEUE_SIZE) {
                state.exitReason = 'exhausted';
                break;
            }

            iterations++;
            state.nodesProcessed++;

            if (!queue.popFast(current as any)) break;

            tracker.mass.subtract('pending', current.prob);

            MassForwardingEngine.forwardNode({
                currentProb: current.prob,
                nodeId: current.nodeId,
                modLevel,
                ctx,
                tracker
            });

            if (instrumentation && exploredTargets.length > 0) {
                const exploredMass = tracker.mass.getExploredMass();
                while (exploredSampleIdx < exploredTargets.length) {
                    const target = exploredTargets[exploredSampleIdx];
                    if (target === undefined || exploredMass < target.units) break;

                    instrumentation.exploredMassSamples = instrumentation.exploredMassSamples ?? [];
                    instrumentation.exploredMassSamples.push({
                        modLevel,
                        targetMass: target.target,
                        exploredMass: ProbUtils.toNumber(exploredMass),
                        frontierProbability: ProbUtils.toNumber(current.prob),
                        iterations,
                        totalIterations: (instrumentation.totalIterations || 0) + iterations
                    });
                    exploredSampleIdx++;
                }
            }
        }

        if (timing) {
            timing.searchMs = (timing.searchMs ?? 0) + performance.now() - aggregateStart;
        }

        if (!state.exitReason) {
            if (queue.size() === 0) state.exitReason = 'empty';
            else if (iterations >= limit) state.exitReason = 'iterations';
            else state.exitReason = 'threshold';
        }

        state.iterations = iterations;
    }
}
