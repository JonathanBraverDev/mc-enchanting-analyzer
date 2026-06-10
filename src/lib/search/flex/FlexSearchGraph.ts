import { ENGINE_LIMITS } from '#constants/engine.js';
import { FLEX_GRAPH_TRAVERSAL } from '#lib/search/flex/FlexConstants.js';
import type { FactorId, RankSelectionStore } from '#lib/search/flex/RankSelectionStore.js';
import type { SearchPool, SearchPoolEntry } from '#lib/search/registry/RegistryKernel.js';
import type { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { PRECISION, ProbUtils } from '#utils/index.js';

export type FlexSearchNodeId = number & { readonly __brand: 'FlexSearchNodeId' };

export interface FlexSearchNode {
    readonly id: FlexSearchNodeId;
    readonly exclusionMask: bigint;
    readonly currentLevel: number;
    readonly count: number;
}

export interface FlexSearchEdge {
    readonly weight: number;
    readonly childId: FlexSearchNodeId;
    readonly factorId: FactorId;
}

export type FlexGraphTerminalReason = 'overflow' | null;

export interface FlexGraphExpansion {
    readonly nodeId: FlexSearchNodeId;
    readonly count: number;
    readonly probContinue: bigint;
    readonly totalWeight: number;
    readonly edges: readonly FlexSearchEdge[];
    readonly terminalReason: FlexGraphTerminalReason;
}

export interface FlexSearchGraphStats {
    readonly nodeCount: number;
    readonly nodeCreateCount: number;
    readonly nodeReuseCount: number;
    readonly expansionBuildCount: number;
    readonly singletonEdgeCount: number;
    readonly choiceEdgeCount: number;
}

interface ScratchGroup {
    exclusionMask: bigint;
    weight: number;
    alternatives: SearchPoolEntry[];
}

/**
 * Structural graph for Flex search rank merging.
 *
 * Nodes carry only future structural state. Picked factors and exact rank
 * pools stay outside the graph.
 */
export class FlexSearchGraph {
    private readonly nodes: FlexSearchNode[] = [];
    private readonly nodeIdsByKey = new Map<string, FlexSearchNodeId>();
    private readonly expansionCache: Array<FlexGraphExpansion | undefined> = [];
    private nodeCreateCount = 0;
    private nodeReuseCount = 0;
    private expansionBuildCount = 0;
    private singletonEdgeCount = 0;
    private choiceEdgeCount = 0;

    public constructor(
        private readonly kernel: RegistryKernel,
        public readonly pool: SearchPool,
        private readonly selections: RankSelectionStore
    ) {}

    public getRootNodeId(initialLevel: number): FlexSearchNodeId {
        return this.getOrCreateNodeId(0n, initialLevel, FLEX_GRAPH_TRAVERSAL.ROOT_ENCHANT_COUNT);
    }

    public getNode(id: FlexSearchNodeId): FlexSearchNode {
        const node = this.nodes[id as number];
        if (!node) throw new Error(`Unknown Flex search graph node ${id}.`);
        return node;
    }

    public getExpansion(nodeId: FlexSearchNodeId): FlexGraphExpansion {
        const cached = this.expansionCache[nodeId as number];
        if (cached) return cached;

        const expansion = this.createExpansion(nodeId);
        this.expansionCache[nodeId as number] = expansion;
        this.expansionBuildCount++;
        return expansion;
    }

    public getMemoryStats(): FlexSearchGraphStats {
        return {
            nodeCount: this.nodes.length,
            nodeCreateCount: this.nodeCreateCount,
            nodeReuseCount: this.nodeReuseCount,
            expansionBuildCount: this.expansionBuildCount,
            singletonEdgeCount: this.singletonEdgeCount,
            choiceEdgeCount: this.choiceEdgeCount
        };
    }

    private createExpansion(nodeId: FlexSearchNodeId): FlexGraphExpansion {
        const node = this.getNode(nodeId);
        if (node.count === FLEX_GRAPH_TRAVERSAL.ROOT_ENCHANT_COUNT) {
            return this.createExpansionFromNode(node, PRECISION, node.currentLevel, FLEX_GRAPH_TRAVERSAL.ENCHANT_COUNT_INCREMENT, null);
        }

        const terminalReason = this.getTerminalReason(node.count);
        const probContinue = terminalReason === 'single-book'
            ? 0n
            : (ProbUtils.PROB_CONTINUE_TABLE[node.currentLevel] ?? PRECISION);
        if (terminalReason !== null) {
            return Object.freeze({
                nodeId,
                count: node.count,
                probContinue,
                totalWeight: 0,
                edges: Object.freeze([]),
                terminalReason: terminalReason === 'max-enchants' ? 'overflow' : null
            });
        }

        const childLevel = Math.floor(node.currentLevel / this.kernel.additionalEnchantmentLevelDivisor);
        const childCount = node.count + FLEX_GRAPH_TRAVERSAL.ENCHANT_COUNT_INCREMENT;
        return this.createExpansionFromNode(node, probContinue, childLevel, childCount, null);
    }

    private createExpansionFromNode(
        node: FlexSearchNode,
        probContinue: bigint,
        childLevel: number,
        childCount: number,
        terminalReason: FlexGraphTerminalReason
    ): FlexGraphExpansion {
        const groups = this.buildGroups(node.exclusionMask);
        const edges = groups.map(group => {
            const childId = this.getOrCreateNodeId(group.exclusionMask, childLevel, childCount);
            const factorId = this.selections.getOrCreateFactor(group.alternatives.map(entry => ({
                enchantId: entry.enchantId,
                weight: entry.weight
            })));
            if (group.alternatives.length === 1) this.singletonEdgeCount++;
            else this.choiceEdgeCount++;
            return Object.freeze({
                weight: group.weight,
                childId,
                factorId
            });
        });
        edges.sort((left, right) => right.weight - left.weight || Number(left.childId) - Number(right.childId));

        return Object.freeze({
            nodeId: node.id,
            count: node.count,
            probContinue,
            totalWeight: groups.reduce((sum, group) => sum + group.weight, 0),
            edges: Object.freeze(edges),
            terminalReason
        });
    }

    private buildGroups(parentExclusionMask: bigint): ScratchGroup[] {
        const groups: ScratchGroup[] = [];
        for (const entry of this.pool.entries) {
            if ((parentExclusionMask & entry.idBit) !== 0n) continue;

            const childExclusionMask = parentExclusionMask | entry.blocksBitset;
            let group = groups.find(candidate => candidate.exclusionMask === childExclusionMask);
            if (!group) {
                group = { exclusionMask: childExclusionMask, weight: 0, alternatives: [] };
                groups.push(group);
            }
            group.weight += entry.weight;
            group.alternatives.push(entry);
        }
        return groups;
    }

    private getOrCreateNodeId(exclusionMask: bigint, currentLevel: number, count: number): FlexSearchNodeId {
        const key = createNodeKey(exclusionMask, currentLevel, count);
        const existing = this.nodeIdsByKey.get(key);
        if (existing !== undefined) {
            this.nodeReuseCount++;
            return existing;
        }

        const id = this.nodes.length as FlexSearchNodeId;
        this.nodes.push(Object.freeze({ id, exclusionMask, currentLevel, count }));
        this.nodeIdsByKey.set(key, id);
        this.expansionCache.push(undefined);
        this.nodeCreateCount++;
        return id;
    }

    private getTerminalReason(count: number): 'max-enchants' | 'single-book' | null {
        if (this.kernel.item === 'book' && !this.kernel.multiEnchantBooks && count >= FLEX_GRAPH_TRAVERSAL.SINGLE_ENCHANT_BOOK_TERMINAL_COUNT) {
            return 'single-book';
        }
        if (count >= ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM) return 'max-enchants';
        return null;
    }
}

function createNodeKey(exclusionMask: bigint, currentLevel: number, count: number): string {
    return `${exclusionMask.toString(16)}:${currentLevel}:${count}`;
}
