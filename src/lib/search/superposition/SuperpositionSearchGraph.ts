import type { SearchPool, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';

export type SuperpositionSearchGraphNodeId = number & { readonly __brand: 'SuperpositionSearchGraphNodeId' };

export interface SuperpositionSearchGraphKey {
    readonly version: string;
    readonly item: string;
    readonly poolSignature: SearchPoolSignature;
    readonly bookMode: 'single-book' | 'multi-book' | 'item';
    readonly clueMode: string | null;
}

export interface SuperpositionSearchGraphNode {
    readonly id: SuperpositionSearchGraphNodeId;
    readonly exclusionMask: bigint;
    readonly currentLevel: number;
    readonly count: number;
}

/**
 * Opt-in structural graph skeleton for conflict-group superposition search.
 *
 * This intentionally does not replace `SearchGraph`. The first implementation
 * slices only establish the aggregate node identity seam so future commits can
 * add expansion and payload handling behind an explicit opt-in path.
 */
export class SuperpositionSearchGraph {
    public readonly key: SuperpositionSearchGraphKey;
    public readonly pool: SearchPool;

    private readonly exclusionMasks: bigint[] = [];
    private readonly currentLevels: number[] = [];
    private readonly counts: number[] = [];
    private readonly nodeIndex = new Map<string, SuperpositionSearchGraphNodeId>();

    public constructor(
        kernel: RegistryKernel,
        pool: SearchPool,
        options: { clueMode?: string | null | undefined } = {}
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
        return this.counts.length;
    }

    public getRootNode(initialLevel: number): SuperpositionSearchGraphNode {
        return this.getOrCreateNode(0n, initialLevel, 0);
    }

    public getOrCreateNode(
        exclusionMask: bigint,
        currentLevel: number,
        count: number
    ): SuperpositionSearchGraphNode {
        const key = this.createNodeKey(exclusionMask, currentLevel, count);
        const existing = this.nodeIndex.get(key);
        if (existing !== undefined) return this.getNode(existing);

        const id = this.counts.length as SuperpositionSearchGraphNodeId;
        this.exclusionMasks.push(exclusionMask);
        this.currentLevels.push(currentLevel);
        this.counts.push(count);
        this.nodeIndex.set(key, id);
        return this.getNode(id);
    }

    public getNode(id: SuperpositionSearchGraphNodeId): SuperpositionSearchGraphNode {
        this.assertNode(id);
        return Object.freeze({
            id,
            exclusionMask: this.exclusionMasks[id]!,
            currentLevel: this.currentLevels[id]!,
            count: this.counts[id]!
        });
    }

    private createNodeKey(exclusionMask: bigint, currentLevel: number, count: number): string {
        return `${exclusionMask.toString(16)}|${currentLevel}|${count}`;
    }

    private assertNode(id: SuperpositionSearchGraphNodeId): void {
        if (id < 0 || id >= this.counts.length) {
            throw new Error(`Unknown superposition search graph node ${id}`);
        }
    }

    private getBookMode(kernel: RegistryKernel): SuperpositionSearchGraphKey['bookMode'] {
        if (kernel.item !== 'book') return 'item';
        return kernel.multiEnchantBooks ? 'multi-book' : 'single-book';
    }
}
