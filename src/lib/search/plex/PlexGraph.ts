import { ENGINE_LIMITS } from '#constants/engine.js';
import type { SearchPool, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import type { PackedEnchant } from '#types/index.js';
import { PRECISION, ProbUtils } from '#utils/index.js';
import {
    canonicalizeWeightedChoice,
    comparePlexWeightedChoices,
    type PlexWeightedChoice
} from '#lib/search/plex/PlexChoice.js';

export type PlexNodeId = number & { readonly __brand: 'PlexNodeId' };

export interface PlexKey {
    readonly version: string;
    readonly item: string;
    readonly poolSignature: SearchPoolSignature;
    readonly bookMode: 'single-book' | 'multi-book' | 'item';
    readonly clueMode: string | null;
}

export interface PlexNode {
    readonly id: PlexNodeId;
    readonly exclusionMask: bigint;
    readonly currentLevel: number;
    readonly count: number;
}

export interface PlexEdge {
    readonly choice: PlexWeightedChoice;
    /** Sum of concrete entry weights before the choice's internal ratio is reduced. */
    readonly weight: number;
    readonly childExclusionMask: bigint;
    readonly childId: PlexNodeId;
}

// TODO: Consider renaming this to PlexStopReason or a status object if the null-as-open sentinel starts leaking.
export type PlexTerminalReason = 'max-enchants' | 'single-book' | 'no-eligible' | null;

export interface PlexExpansion {
    readonly nodeId: PlexNodeId;
    readonly isRoot: boolean;
    readonly probContinue: bigint;
    /** Number of concrete eligible pool entries represented by this expansion. */
    readonly eligibleEntryCount: number;
    /** Sum of concrete eligible entry weights, before any plex edge compression. */
    readonly totalWeight: number;
    readonly edges: readonly PlexEdge[];
    readonly terminalReason: PlexTerminalReason;
}

interface PendingEdgeGroup {
    readonly childExclusionMask: bigint;
    readonly weightsByAlternative: Map<PackedEnchant, number>;
    weight: number;
}

/**
 * Opt-in structural graph skeleton for conflict-group plex search.
 *
 * Naming note: `Plex*` is still provisional. The behavior this type owns
 * is the aggregate structural node keyed by future exclusion state, not any public
 * product concept. Renaming this before it becomes default should be cheap.
 *
 * This intentionally does not replace `SearchGraph`. The first implementation
 * slices only establish the aggregate node identity seam so future commits can
 * add expansion and payload handling behind an explicit opt-in path.
 */
export class PlexGraph {
    public readonly key: PlexKey;
    public readonly pool: SearchPool;

    private readonly exclusionMasks: bigint[] = [];
    private readonly currentLevels: number[] = [];
    private readonly counts: number[] = [];
    private readonly nodeIndex = new Map<bigint, Map<number, PlexNodeId>>();
    private readonly expansionCache: Array<PlexExpansion | undefined> = [];

    public constructor(
        private readonly kernel: RegistryKernel,
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

    public get expansionCount(): number {
        return this.expansionCache.reduce((count, expansion) => count + (expansion === undefined ? 0 : 1), 0);
    }

    public getRootNode(initialLevel: number): PlexNode {
        return this.getNode(this.getOrCreateNodeId(0n, initialLevel, 0));
    }

    public getOrCreateNode(
        exclusionMask: bigint,
        currentLevel: number,
        count: number
    ): PlexNode {
        return this.getNode(this.getOrCreateNodeId(exclusionMask, currentLevel, count));
    }

    public getNode(id: PlexNodeId): PlexNode {
        this.assertNode(id);
        return Object.freeze({
            id,
            exclusionMask: this.exclusionMasks[id]!,
            currentLevel: this.currentLevels[id]!,
            count: this.counts[id]!
        });
    }

    public getExpansion(nodeId: PlexNodeId): PlexExpansion {
        this.assertNode(nodeId);
        const cached = this.expansionCache[nodeId];
        if (cached) return cached;

        const expansion = this.counts[nodeId] === 0
            ? this.buildRootExpansion(nodeId)
            : this.buildSearchExpansion(nodeId);
        this.expansionCache[nodeId] = expansion;
        return expansion;
    }

    private buildRootExpansion(nodeId: PlexNodeId): PlexExpansion {
        const currentLevel = this.currentLevels[nodeId]!;
        const edges = this.buildGroupedEdges(this.pool.entries, currentLevel, 1, 0n);
        return this.createExpansion(nodeId, true, PRECISION, this.pool.entries.length, edges, edges.length === 0 ? 'no-eligible' : null);
    }

    private buildSearchExpansion(nodeId: PlexNodeId): PlexExpansion {
        const exclusionMask = this.exclusionMasks[nodeId]!;
        const currentLevel = this.currentLevels[nodeId]!;
        const count = this.counts[nodeId]!;
        const terminalReason = this.getTerminalReason(count);
        const probContinue = terminalReason === 'single-book'
            ? 0n
            // currentLevel only drives the chance of another enchantment slot.
            // Eligibility remains fixed by this graph's initial pool signature.
            : (ProbUtils.PROB_CONTINUE_TABLE[currentLevel] ?? PRECISION);

        if (terminalReason === 'max-enchants' || terminalReason === 'single-book') {
            return this.createExpansion(nodeId, false, probContinue, 0, [], terminalReason);
        }

        const eligible = this.pool.entries.filter(entry => (exclusionMask & entry.idBit) === 0n);
        const edges = this.buildGroupedEdges(eligible, Math.floor(currentLevel / 2), count + 1, exclusionMask);
        return this.createExpansion(nodeId, false, probContinue, eligible.length, edges, edges.length === 0 ? 'no-eligible' : null);
    }

    private buildGroupedEdges(
        entries: SearchPool['entries'],
        childLevel: number,
        childCount: number,
        parentExclusionMask: bigint
    ): readonly PlexEdge[] {
        const groupsByChildExclusion = new Map<string, PendingEdgeGroup>();

        for (const entry of entries) {
            const childExclusionMask = parentExclusionMask | entry.blocksBitset;
            const key = childExclusionMask.toString(16);
            let group = groupsByChildExclusion.get(key);
            if (!group) {
                group = { childExclusionMask, weightsByAlternative: new Map<PackedEnchant, number>(), weight: 0 };
                groupsByChildExclusion.set(key, group);
            }
            group.weightsByAlternative.set(
                entry.packedEnchant,
                (group.weightsByAlternative.get(entry.packedEnchant) ?? 0) + entry.weight
            );
            group.weight += entry.weight;
        }

        return Object.freeze([...groupsByChildExclusion.values()]
            .map(group => {
                const choice = canonicalizeWeightedChoice(
                    [...group.weightsByAlternative.entries()].map(([packedEnchant, weight]) => ({ packedEnchant, weight }))
                );
                return Object.freeze({
                    choice,
                    weight: group.weight,
                    childExclusionMask: group.childExclusionMask,
                    childId: this.getOrCreateNodeId(group.childExclusionMask, childLevel, childCount)
                });
            })
            .sort((a, b) => comparePlexWeightedChoices(a.choice, b.choice)));
    }

    private createExpansion(
        nodeId: PlexNodeId,
        isRoot: boolean,
        probContinue: bigint,
        eligibleEntryCount: number,
        edges: readonly PlexEdge[],
        terminalReason: PlexTerminalReason
    ): PlexExpansion {
        return Object.freeze({
            nodeId,
            isRoot,
            probContinue,
            eligibleEntryCount,
            totalWeight: edges.reduce((sum, edge) => sum + edge.weight, 0),
            edges,
            terminalReason
        });
    }

    private getOrCreateNodeId(
        exclusionMask: bigint,
        currentLevel: number,
        count: number
    ): PlexNodeId {
        const stateKey = this.createNodeStateKey(currentLevel, count);
        let nodesByState = this.nodeIndex.get(exclusionMask);
        const existing = nodesByState?.get(stateKey);
        if (existing !== undefined) return existing;

        const id = this.counts.length as PlexNodeId;
        this.exclusionMasks.push(exclusionMask);
        this.currentLevels.push(currentLevel);
        this.counts.push(count);
        this.expansionCache.push(undefined);
        if (!nodesByState) {
            nodesByState = new Map<number, PlexNodeId>();
            this.nodeIndex.set(exclusionMask, nodesByState);
        }
        nodesByState.set(stateKey, id);
        return id;
    }

    private createNodeStateKey(currentLevel: number, count: number): number {
        return (currentLevel * (ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM + 1)) + count;
    }

    private getTerminalReason(count: number): PlexTerminalReason {
        if (this.kernel.item === 'book' && !this.kernel.multiEnchantBooks && count >= 1) {
            return 'single-book';
        }
        if (count >= ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM) {
            return 'max-enchants';
        }
        return null;
    }

    private assertNode(id: PlexNodeId): void {
        if (id < 0 || id >= this.counts.length) {
            throw new Error(`Unknown plex graph node ${id}`);
        }
    }

    private getBookMode(kernel: RegistryKernel): PlexKey['bookMode'] {
        if (kernel.item !== 'book') return 'item';
        return kernel.multiEnchantBooks ? 'multi-book' : 'single-book';
    }
}
