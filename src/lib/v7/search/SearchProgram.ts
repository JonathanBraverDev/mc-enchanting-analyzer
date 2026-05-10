import { ENGINE_LIMITS } from '#constants/engine.js';
import { PackedCombo } from '#types/index.js';
import { ComboUtils, PRECISION, ProbUtils } from '#utils/index.js';
import { RegistryKernel, V7PoolEntry, V7PoolProjection, V7PoolSignature } from '#lib/v7/registry/RegistryKernel.js';

export type V7ProgramNodeId = number & { readonly __brand: 'V7ProgramNodeId' };

export interface V7ProgramKey {
    readonly version: string;
    readonly item: string;
    readonly poolSignature: V7PoolSignature;
    readonly bookMode: 'single-book' | 'multi-book' | 'item';
    readonly clueMode: string | null;
}

export interface V7ProgramNode {
    readonly id: V7ProgramNodeId;
    readonly selectedMask: bigint;
    readonly currentLevel: number;
    readonly combo: PackedCombo;
    readonly count: number;
}

export interface V7ProgramEdge {
    readonly entry: V7PoolEntry;
    readonly weight: number;
    readonly childId: V7ProgramNodeId;
}

export type V7ProgramTerminalReason = 'max-enchants' | 'single-book' | 'no-eligible' | null;

export interface V7ProgramExpansion {
    readonly nodeId: V7ProgramNodeId;
    readonly isRoot: boolean;
    readonly probContinue: bigint;
    readonly totalWeight: number;
    readonly eligibleCount: number;
    readonly edges: readonly V7ProgramEdge[];
    readonly terminalReason: V7ProgramTerminalReason;
}

/**
 * Immutable/lazy structural search program for one V7 pool signature.
 *
 * The program owns node identity and expansion structure only. It deliberately
 * stores no probability mass; SearchRun will later attach weighted mass vectors
 * to these nodes and can share future work whenever `(programKey, nodeKey)` is
 * identical.
 */
export class SearchProgram {
    public readonly key: V7ProgramKey;
    public readonly pool: V7PoolProjection;

    private readonly nodes: V7ProgramNode[] = [];
    private readonly nodeIndex = new Map<bigint, V7ProgramNodeId>();
    private readonly expansionCache = new Map<V7ProgramNodeId, V7ProgramExpansion>();

    public constructor(
        private readonly kernel: RegistryKernel,
        pool: V7PoolProjection,
        options: { clueMode?: string | null } = {}
    ) {
        this.pool = pool;
        this.key = Object.freeze({
            version: kernel.version,
            item: kernel.item,
            poolSignature: pool.signature,
            bookMode: this.getBookMode(kernel),
            clueMode: options.clueMode ?? null
        });
    }

    public get size(): number {
        return this.nodes.length;
    }

    public getRootNode(initialLevel: number): V7ProgramNode {
        return this.getOrCreateNode(0n, initialLevel, 0 as PackedCombo, 0);
    }

    public getNode(id: V7ProgramNodeId): V7ProgramNode {
        const node = this.nodes[id];
        if (!node) throw new Error(`Unknown V7 search program node ${id}`);
        return node;
    }

    public getExpansion(nodeId: V7ProgramNodeId): V7ProgramExpansion {
        const cached = this.expansionCache.get(nodeId);
        if (cached) return cached;

        const node = this.getNode(nodeId);
        const expansion = node.count === 0
            ? this.buildRootExpansion(node)
            : this.buildSearchExpansion(node);
        this.expansionCache.set(nodeId, expansion);
        return expansion;
    }

    private buildRootExpansion(node: V7ProgramNode): V7ProgramExpansion {
        const edges = this.pool.entries.map(entry => ({
            entry,
            weight: entry.weight,
            childId: this.getOrCreateNode(entry.idBit, node.currentLevel, entry.comboIndex as PackedCombo, 1).id
        }));

        return {
            nodeId: node.id,
            isRoot: true,
            probContinue: PRECISION,
            totalWeight: this.pool.totalWeight,
            eligibleCount: edges.length,
            edges,
            terminalReason: edges.length === 0 ? 'no-eligible' : null
        };
    }

    private buildSearchExpansion(node: V7ProgramNode): V7ProgramExpansion {
        const terminalReason = this.getTerminalReason(node);
        const probContinue = terminalReason === 'single-book'
            ? 0n
            // currentLevel only drives the chance of another enchantment slot.
            // Eligibility remains fixed by this program's initial pool signature.
            : (ProbUtils.PROB_CONTINUE_TABLE[node.currentLevel] ?? PRECISION);

        if (terminalReason === 'max-enchants' || terminalReason === 'single-book') {
            return this.createExpansion(node, probContinue, [], terminalReason);
        }

        const nextLevel = Math.floor(node.currentLevel / 2);
        const edges: V7ProgramEdge[] = [];
        let totalWeight = 0;

        for (const entry of this.pool.entries) {
            if ((node.selectedMask & entry.idBit) !== 0n) continue;
            if ((node.selectedMask & entry.conflictBitset) !== 0n) continue;

            const childMask = node.selectedMask | entry.idBit;
            const childCombo = ComboUtils.packAppendIndex(node.combo, entry.comboIndex, node.count);
            const child = this.getOrCreateNode(childMask, nextLevel, childCombo, node.count + 1);
            totalWeight += entry.weight;
            edges.push({
                entry,
                weight: entry.weight,
                childId: child.id
            });
        }

        return this.createExpansion(node, probContinue, edges, edges.length === 0 ? 'no-eligible' : null, totalWeight);
    }

    private createExpansion(
        node: V7ProgramNode,
        probContinue: bigint,
        edges: readonly V7ProgramEdge[],
        terminalReason: V7ProgramTerminalReason,
        totalWeight = edges.reduce((sum, edge) => sum + edge.weight, 0)
    ): V7ProgramExpansion {
        return {
            nodeId: node.id,
            isRoot: node.count === 0,
            probContinue,
            totalWeight,
            eligibleCount: edges.length,
            edges,
            terminalReason
        };
    }

    private getOrCreateNode(
        selectedMask: bigint,
        currentLevel: number,
        combo: PackedCombo,
        count: number
    ): V7ProgramNode {
        const key = this.createNodeKey(selectedMask, currentLevel);
        const existing = this.nodeIndex.get(key);
        if (existing !== undefined) return this.getNode(existing);

        const node = {
            id: this.nodes.length as V7ProgramNodeId,
            selectedMask,
            currentLevel,
            combo,
            count
        };
        this.nodes.push(node);
        this.nodeIndex.set(key, node.id);
        return node;
    }

    private createNodeKey(selectedMask: bigint, currentLevel: number): bigint {
        return (selectedMask << 8n) | BigInt(currentLevel);
    }

    private getTerminalReason(node: V7ProgramNode): V7ProgramTerminalReason {
        if (this.kernel.item === 'book' && !this.kernel.multiEnchantBooks && node.count >= 1) {
            return 'single-book';
        }
        if (node.count >= ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM) {
            return 'max-enchants';
        }
        return null;
    }

    private getBookMode(kernel: RegistryKernel): V7ProgramKey['bookMode'] {
        if (kernel.item !== 'book') return 'item';
        return kernel.multiEnchantBooks ? 'multi-book' : 'single-book';
    }
}
