import { SearchGraph, type SearchGraphNodeId } from '#lib/search/SearchGraph.js';
import { ComboUtils } from '#utils/index.js';
import type {
    FlexEdge,
    FlexExpansion,
    FlexGraph,
    FlexNode,
    FlexNodeId,
    FlexProgramId
} from '#lib/search/flex/FlexTypes.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';

/**
 * Concrete-equivalent Flex graph adapter.
 *
 * The wrapped SearchGraph remains the source of truth for vanilla eligibility,
 * conflicts, levels, weights, and structural node reuse. SolidFlexGraph only
 * assigns Flex program IDs to those concrete nodes.
 */
export class SolidFlexGraph implements FlexGraph {
    private readonly programsByNode = new Map<number, FlexProgramId>();
    private readonly expansionCache = new Map<number, FlexExpansion>();

    public constructor(
        private readonly graph: SearchGraph,
        private readonly programs: FlexProgramStore,
        private readonly indexToEnchant: number[]
    ) {}

    public getRootNode(initialLevel: number): FlexNode {
        const root = this.graph.getRootNode(initialLevel);
        return this.createNode(root.id, this.programs.empty);
    }

    public getExpansion(nodeId: FlexNodeId): FlexExpansion {
        const cached = this.expansionCache.get(nodeId as number);
        if (cached) return cached;

        const searchNodeId = nodeId as number as SearchGraphNodeId;
        const searchExpansion = this.graph.getExpansion(searchNodeId);
        const node = this.createNode(searchNodeId, this.getProgramForSearchNode(searchNodeId));
        const edges = Object.freeze(searchExpansion.edges.map<FlexEdge>(edge => Object.freeze({
            weight: edge.weight,
            childId: this.createNode(edge.childId, this.getProgramForSearchNode(edge.childId)).id
        })));
        const expansion = Object.freeze({
            node,
            probContinue: searchExpansion.probContinue,
            totalWeight: searchExpansion.totalWeight,
            edges,
            terminalReason: searchExpansion.terminalReason === 'max-enchants' ? 'overflow' : null
        });

        this.expansionCache.set(nodeId as number, expansion);
        return expansion;
    }

    public getNode(nodeId: FlexNodeId): FlexNode {
        const searchNodeId = nodeId as number as SearchGraphNodeId;
        return this.createNode(searchNodeId, this.getProgramForSearchNode(searchNodeId));
    }

    public getProgramId(nodeId: FlexNodeId): FlexProgramId {
        return this.getProgramForSearchNode(nodeId as number as SearchGraphNodeId);
    }

    private createNode(searchNodeId: SearchGraphNodeId, programId: FlexProgramId): FlexNode {
        const existing = this.programsByNode.get(searchNodeId as number);
        if (existing !== undefined && existing !== programId) {
            throw new Error(
                `SolidFlexGraph node ${String(searchNodeId)} reached with program ${String(programId)} after ${String(existing)}.`
            );
        }

        this.programsByNode.set(searchNodeId as number, programId);
        return this.programs.createNode(searchNodeId as number as FlexNodeId, programId);
    }

    private getProgramForSearchNode(searchNodeId: SearchGraphNodeId): FlexProgramId {
        const cached = this.programsByNode.get(searchNodeId as number);
        if (cached !== undefined) return cached;

        const combo = this.graph.getNodeCombo(searchNodeId);
        let programId = this.programs.empty;
        for (const packedEnchant of ComboUtils.unpack(combo, this.indexToEnchant)) {
            programId = this.programs.appendFixed(programId, packedEnchant);
        }
        this.programsByNode.set(searchNodeId as number, programId);
        return programId;
    }
}
