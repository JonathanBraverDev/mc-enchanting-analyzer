import { AsyncUtils, ProbUtils } from '#utils/index.js';
import { ENGINE_LIMITS, SEARCH_CONSTANTS } from '#constants/engine.js';
import { SearchState, SearchContext, ForwardingContext } from '#types/index.js';
import { SearchProcessor } from './SearchProcessor.js';
import { ComboUtils } from '#utils/index.js';
import { PackedCombo } from '#types/index.js';

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
        let checkpointIdx = 0;
        const current = { meta: 0n, prob: 0n, level: 0, combo: 0 as any as PackedCombo };

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
            
            if (!SearchProcessor.withTiming(timing, 'heapMs', () => queue.popFast(current as any))) break;

            tracker.subtract('pending', current.prob);
            const currentCount = ComboUtils.getCount(current.combo);

            SearchProcessor.withTiming(timing, 'searchMs', () => {
                if (currentCount === 0) {
                    SearchProcessor.processInitialNode(current.prob, modLevel, ctx, tracker);
                } else {
                    SearchProcessor.processSearchNode(current.prob, current.meta, current.combo, currentCount, ctx, tracker);
                }
            });

            // Checkpoints
            const bk = tracker.getBookkeeping();
            while (checkpointIdx < SEARCH_CONSTANTS.CHECKPOINT_TARGETS.length) {
                const targetMass = SEARCH_CONSTANTS.CHECKPOINT_TARGETS[checkpointIdx];
                if (targetMass === undefined) break;
                const currentSettledMass = bk.resolved + bk.sieved + bk.overflow;
                if (currentSettledMass < targetMass) break;
                state.checkpoints.push({
                    modLevel,
                    threshold: ProbUtils.toNumber(current.prob),
                    mass: ProbUtils.toNumber(currentSettledMass),
                    iterations,
                    totalIterations: iterations
                });
                checkpointIdx++;
            }
        }

        if (!state.exitReason) {
            if (queue.size() === 0) state.exitReason = 'empty';
            else if (iterations >= limit) state.exitReason = 'iterations';
            else state.exitReason = 'threshold';
        }

        state.iterations = iterations;
    }
}
