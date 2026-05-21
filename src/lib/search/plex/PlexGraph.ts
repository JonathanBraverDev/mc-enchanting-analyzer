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
import { PLEX_GRAPH_RULES, PLEX_HASH_CONSTANTS, PLEX_INDEX_LIMITS, PLEX_INDEX_SENTINELS } from '#lib/search/plex/PlexConstants.js';

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
    readonly alternatives: PackedEnchant[];
    readonly weights: number[];
    weight: number;
}

const PLEX_NODE_STATE_COUNT_STRIDE = ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM + 1;

class PlexNodeIndex {
    private exclusionMasks: bigint[] = [];
    private stateKeys: Int32Array;
    private values: Int32Array;
    private used: Uint8Array;
    private mask: number;
    private resizeAt: number;
    private count = 0;

    public constructor(capacity: number = PLEX_INDEX_LIMITS.GRAPH_INITIAL_CAPACITY) {
        const size = PlexNodeIndex.nextPowerOfTwo(capacity);
        this.stateKeys = new Int32Array(size);
        this.values = new Int32Array(size);
        this.values.fill(PLEX_INDEX_SENTINELS.MISSING_VALUE);
        this.used = new Uint8Array(size);
        this.mask = size - 1;
        this.resizeAt = Math.floor(size * PLEX_INDEX_LIMITS.GRAPH_MAX_LOAD_FACTOR);
    }

    public get(exclusionMask: bigint, stateKey: number): PlexNodeId | undefined {
        let index = this.hash(exclusionMask, stateKey) & this.mask;
        while (this.used[index] !== PLEX_INDEX_SENTINELS.EMPTY_SLOT) {
            if (this.stateKeys[index] === stateKey && this.exclusionMasks[index] === exclusionMask) {
                const value = this.values[index]!;
                return value === PLEX_INDEX_SENTINELS.MISSING_VALUE ? undefined : value as PlexNodeId;
            }
            index = (index + 1) & this.mask;
        }
        return undefined;
    }

    public set(exclusionMask: bigint, stateKey: number, value: PlexNodeId): void {
        if (this.count >= this.resizeAt) this.grow();
        this.insert(exclusionMask, stateKey, value);
    }

    private insert(exclusionMask: bigint, stateKey: number, value: PlexNodeId): void {
        let index = this.hash(exclusionMask, stateKey) & this.mask;
        while (this.used[index] !== PLEX_INDEX_SENTINELS.EMPTY_SLOT) {
            if (this.stateKeys[index] === stateKey && this.exclusionMasks[index] === exclusionMask) {
                this.values[index] = value;
                return;
            }
            index = (index + 1) & this.mask;
        }

        this.used[index] = PLEX_INDEX_SENTINELS.OCCUPIED_SLOT;
        this.exclusionMasks[index] = exclusionMask;
        this.stateKeys[index] = stateKey;
        this.values[index] = value;
        this.count++;
    }

    private grow(): void {
        const oldMasks = this.exclusionMasks;
        const oldStateKeys = this.stateKeys;
        const oldValues = this.values;
        const oldUsed = this.used;
        const nextSize = oldStateKeys.length * PLEX_INDEX_LIMITS.GROWTH_FACTOR;

        this.exclusionMasks = [];
        this.stateKeys = new Int32Array(nextSize);
        this.values = new Int32Array(nextSize);
        this.values.fill(PLEX_INDEX_SENTINELS.MISSING_VALUE);
        this.used = new Uint8Array(nextSize);
        this.mask = nextSize - 1;
        this.resizeAt = Math.floor(nextSize * PLEX_INDEX_LIMITS.GRAPH_MAX_LOAD_FACTOR);
        this.count = 0;

        for (let i = 0; i < oldStateKeys.length; i++) {
            if (oldUsed[i] !== PLEX_INDEX_SENTINELS.EMPTY_SLOT) this.insert(oldMasks[i]!, oldStateKeys[i]!, oldValues[i]! as PlexNodeId);
        }
    }

    private hash(exclusionMask: bigint, stateKey: number): number {
        const low = Number(exclusionMask & PLEX_HASH_CONSTANTS.U32_MASK) >>> 0;
        const high = Number((exclusionMask >> PLEX_HASH_CONSTANTS.U32_SHIFT) & PLEX_HASH_CONSTANTS.U32_MASK) >>> 0;
        let h = (low
            ^ Math.imul(high, PLEX_HASH_CONSTANTS.GOLDEN_RATIO_32)
            ^ Math.imul(stateKey, PLEX_HASH_CONSTANTS.STATE_KEY_MULTIPLIER)) >>> 0;
        h ^= h >>> PLEX_HASH_CONSTANTS.AVALANCHE_SHIFT_1;
        h = Math.imul(h, PLEX_HASH_CONSTANTS.AVALANCHE_MULTIPLIER_1) >>> 0;
        h ^= h >>> PLEX_HASH_CONSTANTS.AVALANCHE_SHIFT_2;
        h = Math.imul(h, PLEX_HASH_CONSTANTS.AVALANCHE_MULTIPLIER_2) >>> 0;
        return (h ^ (h >>> PLEX_HASH_CONSTANTS.AVALANCHE_SHIFT_1)) >>> 0;
    }

    private static nextPowerOfTwo(value: number): number {
        let size = 1;
        while (size < value) size <<= 1;
        return size;
    }
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
    private readonly nodeIndex = new PlexNodeIndex();
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
        return this.getNode(this.getOrCreateNodeId(
            PLEX_GRAPH_RULES.ROOT_EXCLUSION_MASK,
            initialLevel,
            PLEX_GRAPH_RULES.ROOT_COUNT
        ));
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

        const expansion = this.counts[nodeId] === PLEX_GRAPH_RULES.ROOT_COUNT
            ? this.buildRootExpansion(nodeId)
            : this.buildSearchExpansion(nodeId);
        this.expansionCache[nodeId] = expansion;
        return expansion;
    }

    private buildRootExpansion(nodeId: PlexNodeId): PlexExpansion {
        const currentLevel = this.currentLevels[nodeId]!;
        const edges = this.buildGroupedEdges(
            this.pool.entries,
            currentLevel,
            PLEX_GRAPH_RULES.FIRST_CHILD_COUNT,
            PLEX_GRAPH_RULES.ROOT_EXCLUSION_MASK
        );
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
        const edges = this.buildGroupedEdges(
            eligible,
            Math.floor(currentLevel / PLEX_GRAPH_RULES.NEXT_LEVEL_DIVISOR),
            count + PLEX_GRAPH_RULES.FIRST_CHILD_COUNT,
            exclusionMask
        );
        return this.createExpansion(nodeId, false, probContinue, eligible.length, edges, edges.length === 0 ? 'no-eligible' : null);
    }

    private buildGroupedEdges(
        entries: SearchPool['entries'],
        childLevel: number,
        childCount: number,
        parentExclusionMask: bigint
    ): readonly PlexEdge[] {
        const groups: PendingEdgeGroup[] = [];

        for (const entry of entries) {
            const childExclusionMask = parentExclusionMask | entry.blocksBitset;
            let group = groups.find(candidate => candidate.childExclusionMask === childExclusionMask);
            if (!group) {
                group = { childExclusionMask, alternatives: [], weights: [], weight: 0 };
                groups.push(group);
            }

            const alternativeIndex = group.alternatives.indexOf(entry.packedEnchant);
            if (alternativeIndex === -1) {
                group.alternatives.push(entry.packedEnchant);
                group.weights.push(entry.weight);
            } else {
                group.weights[alternativeIndex] = group.weights[alternativeIndex]! + entry.weight;
            }
            group.weight += entry.weight;
        }

        return Object.freeze(groups
            .map(group => {
                const choice = canonicalizeWeightedChoice(
                    group.alternatives.map((packedEnchant, index) => ({ packedEnchant, weight: group.weights[index]! }))
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
        const existing = this.nodeIndex.get(exclusionMask, stateKey);
        if (existing !== undefined) return existing;

        const id = this.counts.length as PlexNodeId;
        this.exclusionMasks.push(exclusionMask);
        this.currentLevels.push(currentLevel);
        this.counts.push(count);
        this.expansionCache.push(undefined);
        this.nodeIndex.set(exclusionMask, stateKey, id);
        return id;
    }

    private createNodeStateKey(currentLevel: number, count: number): number {
        return (currentLevel * PLEX_NODE_STATE_COUNT_STRIDE) + count;
    }

    private getTerminalReason(count: number): PlexTerminalReason {
        if (this.kernel.item === 'book' && !this.kernel.multiEnchantBooks && count >= PLEX_GRAPH_RULES.SINGLE_BOOK_ENCHANT_LIMIT) {
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
