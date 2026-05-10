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

    private readonly selectedMasks: bigint[] = [];
    private readonly currentLevels: number[] = [];
    private readonly combos: PackedCombo[] = [];
    private readonly counts: number[] = [];
    private readonly nodeIndex = new Map<bigint, V7ProgramNodeId>();
    private readonly expansionCache: Array<V7ProgramExpansion | undefined> = [];

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
        return this.combos.length;
    }

    public getRootNode(initialLevel: number): V7ProgramNode {
        return this.getNode(this.getOrCreateNodeId(0n, initialLevel, 0 as PackedCombo, 0));
    }

    public getNode(id: V7ProgramNodeId): V7ProgramNode {
        this.assertNode(id);
        return {
            id,
            selectedMask: this.selectedMasks[id]!,
            currentLevel: this.currentLevels[id]!,
            combo: this.combos[id]!,
            count: this.counts[id]!
        };
    }

    public getNodeCombo(id: V7ProgramNodeId): PackedCombo {
        this.assertNode(id);
        return this.combos[id]!;
    }

    public getNodeCount(id: V7ProgramNodeId): number {
        this.assertNode(id);
        return this.counts[id]!;
    }

    public getExpansion(nodeId: V7ProgramNodeId): V7ProgramExpansion {
        const cached = this.expansionCache[nodeId];
        if (cached) return cached;

        const expansion = this.counts[nodeId] === 0
            ? this.buildRootExpansion(nodeId)
            : this.buildSearchExpansion(nodeId);
        this.expansionCache[nodeId] = expansion;
        return expansion;
    }

    private buildRootExpansion(nodeId: V7ProgramNodeId): V7ProgramExpansion {
        const currentLevel = this.currentLevels[nodeId]!;
        const edges = this.pool.entries.map(entry => ({
            entry,
            weight: entry.weight,
            childId: this.getOrCreateNodeId(entry.idBit, currentLevel, entry.comboIndex as PackedCombo, 1)
        }));

        return {
            nodeId,
            isRoot: true,
            probContinue: PRECISION,
            totalWeight: this.pool.totalWeight,
            eligibleCount: edges.length,
            edges,
            terminalReason: edges.length === 0 ? 'no-eligible' : null
        };
    }

    private buildSearchExpansion(nodeId: V7ProgramNodeId): V7ProgramExpansion {
        const selectedMask = this.selectedMasks[nodeId]!;
        const currentLevel = this.currentLevels[nodeId]!;
        const combo = this.combos[nodeId]!;
        const count = this.counts[nodeId]!;
        const terminalReason = this.getTerminalReason(count);
        const probContinue = terminalReason === 'single-book'
            ? 0n
            // currentLevel only drives the chance of another enchantment slot.
            // Eligibility remains fixed by this program's initial pool signature.
            : (ProbUtils.PROB_CONTINUE_TABLE[currentLevel] ?? PRECISION);

        if (terminalReason === 'max-enchants' || terminalReason === 'single-book') {
            return this.createExpansion(nodeId, count, probContinue, [], terminalReason);
        }

        const nextLevel = Math.floor(currentLevel / 2);
        const nextCount = count + 1;
        const edges: V7ProgramEdge[] = [];
        let totalWeight = 0;

        for (const entry of this.pool.entries) {
            if ((selectedMask & entry.idBit) !== 0n) continue;
            if ((selectedMask & entry.conflictBitset) !== 0n) continue;

            const childMask = selectedMask | entry.idBit;
            const childCombo = ComboUtils.packAppendIndex(combo, entry.comboIndex, count);
            const childId = this.getOrCreateNodeId(childMask, nextLevel, childCombo, nextCount);
            totalWeight += entry.weight;
            edges.push({
                entry,
                weight: entry.weight,
                childId
            });
        }

        return this.createExpansion(nodeId, count, probContinue, edges, edges.length === 0 ? 'no-eligible' : null, totalWeight);
    }

    private createExpansion(
        nodeId: V7ProgramNodeId,
        count: number,
        probContinue: bigint,
        edges: readonly V7ProgramEdge[],
        terminalReason: V7ProgramTerminalReason,
        totalWeight = edges.reduce((sum, edge) => sum + edge.weight, 0)
    ): V7ProgramExpansion {
        return {
            nodeId,
            isRoot: count === 0,
            probContinue,
            totalWeight,
            eligibleCount: edges.length,
            edges,
            terminalReason
        };
    }

    private getOrCreateNodeId(
        selectedMask: bigint,
        currentLevel: number,
        combo: PackedCombo,
        count: number
    ): V7ProgramNodeId {
        const key = this.createNodeKey(selectedMask, currentLevel);
        const existing = this.nodeIndex.get(key);
        if (existing !== undefined) return existing;

        const nodeId = this.combos.length as V7ProgramNodeId;
        this.selectedMasks.push(selectedMask);
        this.currentLevels.push(currentLevel);
        this.combos.push(combo);
        this.counts.push(count);
        this.expansionCache.push(undefined);
        this.nodeIndex.set(key, nodeId);
        return nodeId;
    }

    private createNodeKey(selectedMask: bigint, currentLevel: number): bigint {
        return (selectedMask << 8n) | BigInt(currentLevel);
    }

    private getTerminalReason(count: number): V7ProgramTerminalReason {
        if (this.kernel.item === 'book' && !this.kernel.multiEnchantBooks && count >= 1) {
            return 'single-book';
        }
        if (count >= ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM) {
            return 'max-enchants';
        }
        return null;
    }

    private assertNode(id: V7ProgramNodeId): void {
        if (id < 0 || id >= this.combos.length) {
            throw new Error(`Unknown V7 search program node ${id}`);
        }
    }

    private getBookMode(kernel: RegistryKernel): V7ProgramKey['bookMode'] {
        if (kernel.item !== 'book') return 'item';
        return kernel.multiEnchantBooks ? 'multi-book' : 'single-book';
    }
}
