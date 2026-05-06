import { MassBucketUnits } from '#types/mass.js';
import { PackedCombo, SearchState } from '#types/index.js';
import { PRECISION } from '#utils/index.js';

import { NodeIdSearchFrontier } from '#engine/search/NodeIdSearchFrontier.js';
import { ProbabilityMassAccountant } from '#engine/search/ProbabilityMassAccountant.js';
import { SearchNodeGraph } from '#engine/search/SearchNodeGraph.js';

/**
 * Unified state accountant for probability mass and expanded node blueprints.
 * Facilitates high-speed forwarding through cached search subtrees.
 */
export class SearchStateTracker {
    public readonly mass: ProbabilityMassAccountant;

    constructor(initialMass?: MassBucketUnits) {
        this.mass = new ProbabilityMassAccountant(initialMass);
    }

    /**
     * Initializes a new SearchState or clones an existing one.
     */
    public static createState(
        modLevel: number,
        existing?: SearchState,
        threshold: bigint = 0n
    ): SearchState {
        if (existing) {
            return {
                queue: existing.queue.clone(),
                graph: existing.graph.clone(),
                results: new Map(existing.results),
                tracker: existing.tracker.clone(),
                threshold,
                // iterations resets each run so SearchController can enforce per-run limits;
                // nodesProcessed is cumulative across all checkpoints and used for diagnostics only.
                iterations: 0,
                nodesProcessed: existing.nodesProcessed
            };
        }

        const results = new Map<PackedCombo, bigint>();
        const queue = new NodeIdSearchFrontier();
        const graph = new SearchNodeGraph();

        // Always start from an empty generation state (0 packed, 0 bitset)
        const initialPacked = 0 as PackedCombo;
        const rootNodeId = graph.getOrCreateNumericNode(0, 0, modLevel, initialPacked, 0);

        queue.pushOrMerge(rootNodeId, PRECISION);

        return {
            queue, graph, results,
            tracker: new SearchStateTracker({
                resolved: 0n,
                clueIncompatible: 0n,
                pending: PRECISION,
                sieved: 0n,
                overflow: 0n,
                capped: 0n,
                rounding: 0n,
                recoveredRounding: 0n,
                recoveredSieved: 0n
            }),
            threshold,
            iterations: 0,
            nodesProcessed: 0
        };
    }

    public clone(): SearchStateTracker {
        return new SearchStateTracker(this.mass.getBucketUnits());
    }
}
