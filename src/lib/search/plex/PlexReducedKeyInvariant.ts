import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { PlexGraph, type PlexNodeId } from '#lib/search/plex/PlexGraph.js';
import { PlexPayloadStore } from '#lib/search/plex/PlexPayloadStore.js';
import type { PlexPayload, PlexPayloadKey } from '#lib/search/plex/PlexPayload.js';
import { RegistryKernel, type SearchPool, type SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';

export interface PlexReducedKeyInvariantRequest {
    readonly kernel: RegistryKernel;
    readonly xp: number;
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
    readonly maxConflicts?: number | undefined;
}

export interface PlexReducedKeyInvariantConflict {
    readonly graphId: number;
    readonly nodeId: PlexNodeId;
    readonly firstPayload: PlexPayloadKey;
    readonly nextPayload: PlexPayloadKey;
}

export interface PlexReducedKeyInvariantResult {
    readonly ok: boolean;
    readonly conflicts: readonly PlexReducedKeyInvariantConflict[];
    readonly checkedStateCount: number;
    readonly transitionCount: number;
    readonly graphCount: number;
}

interface PlexInvariantWorkItem {
    readonly graphId: number;
    readonly nodeId: PlexNodeId;
    readonly payload: PlexPayload;
}

interface PlexInvariantGraphRecord {
    readonly id: number;
    readonly graph: PlexGraph;
}

/**
 * Verifies the reduced Plex frontier-key invariant for one registry/item/material/XP cell.
 *
 * The fast Plex frontier stores one pending entry per `(graphId, nodeId)` and asserts that
 * payload identity is functionally determined by that structural state. Vanilla data has
 * this property because same-child alternatives are represented inside `PlexWeightedChoice`
 * edges before graph-node merging happens, but arbitrary registry mutations can break it.
 */
export function checkPlexReducedKeyInvariant(request: PlexReducedKeyInvariantRequest): PlexReducedKeyInvariantResult {
    const distributionService = request.distributionService ?? new ModifiedLevelDistributionService();
    const payloads = new PlexPayloadStore();
    const graphsBySignature = new Map<SearchPoolSignature, PlexInvariantGraphRecord>();
    const graphs: PlexInvariantGraphRecord[] = [];
    const payloadByState = new Map<string, PlexPayload>();
    const stack: PlexInvariantWorkItem[] = [];
    const conflicts: PlexReducedKeyInvariantConflict[] = [];
    const maxConflicts = Math.max(1, request.maxConflicts ?? 10);
    let transitionCount = 0;

    const distribution = distributionService.getModifiedLevelDist(
        request.kernel.registry,
        request.xp,
        request.kernel.enchantability
    );

    for (const [levelText, rootMass] of Object.entries(distribution)) {
        if (rootMass === 0n) continue;
        const level = Number(levelText);
        const graph = getGraphRecord(request.kernel, request.kernel.getPool(level), graphsBySignature, graphs);
        const root = graph.graph.getRootNode(level);
        stack.push({ graphId: graph.id, nodeId: root.id, payload: payloads.empty });
    }

    while (stack.length > 0 && conflicts.length < maxConflicts) {
        const current = stack.pop()!;
        const stateKey = createStateKey(current.graphId, current.nodeId);
        const existing = payloadByState.get(stateKey);
        if (existing) {
            if (existing.id !== current.payload.id) {
                conflicts.push(Object.freeze({
                    graphId: current.graphId,
                    nodeId: current.nodeId,
                    firstPayload: payloads.key(existing),
                    nextPayload: payloads.key(current.payload)
                }));
            }
            continue;
        }
        payloadByState.set(stateKey, current.payload);

        const expansion = graphs[current.graphId]!.graph.getExpansion(current.nodeId);
        if (expansion.edges.length === 0) continue;
        if (!expansion.isRoot && expansion.terminalReason !== null) continue;

        for (const edge of expansion.edges) {
            transitionCount++;
            stack.push({
                graphId: current.graphId,
                nodeId: edge.childId,
                payload: payloads.appendEdge(current.payload, edge)
            });
        }
    }

    return Object.freeze({
        ok: conflicts.length === 0,
        conflicts: Object.freeze(conflicts),
        checkedStateCount: payloadByState.size,
        transitionCount,
        graphCount: graphs.length
    });
}

function getGraphRecord(
    kernel: RegistryKernel,
    pool: SearchPool,
    graphsBySignature: Map<SearchPoolSignature, PlexInvariantGraphRecord>,
    graphs: PlexInvariantGraphRecord[]
): PlexInvariantGraphRecord {
    const cached = graphsBySignature.get(pool.signature);
    if (cached) return cached;

    const record = Object.freeze({
        id: graphs.length,
        graph: new PlexGraph(kernel, pool)
    });
    graphs.push(record);
    graphsBySignature.set(pool.signature, record);
    return record;
}

function createStateKey(graphId: number, nodeId: PlexNodeId): string {
    return `${graphId}:${String(nodeId)}`;
}
