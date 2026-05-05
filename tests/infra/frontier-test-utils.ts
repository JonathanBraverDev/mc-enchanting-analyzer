import { PRECISION } from '#utils/math/ProbUtils.js';
import { NodeIdSearchFrontier } from '#engine/search/NodeIdSearchFrontier.js';
import { SearchNodeGraph } from '#engine/search/SearchNodeGraph.js';
import type { PackedCombo, SearchFrontierSnapshot } from '#types/index.js';

export function makeFrontierSnapshot(
    combo: PackedCombo,
    count: number,
    prob: bigint = PRECISION,
    scale: bigint = PRECISION
): SearchFrontierSnapshot[] {
    const frontier = new NodeIdSearchFrontier();
    const graph = new SearchNodeGraph();
    const nodeId = graph.createNumericNode(1, 0, 30, combo, count);
    frontier.pushOrMerge(nodeId, prob);
    return [{ frontier, graph, scale }];
}
