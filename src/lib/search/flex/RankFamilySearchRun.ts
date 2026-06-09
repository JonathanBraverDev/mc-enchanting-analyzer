import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { PRECISION, ProbUtils } from '#utils/index.js';
import type { SearchPool, SearchPoolFamilySignature } from '#lib/search/registry/RegistryKernel.js';
import type { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import {
    type FactorSetId,
    type RankPoolMix,
    type RankPoolMixId,
    type RankPoolWeight,
    type RankSelectionStore,
    type SelectionId
} from '#lib/search/flex/RankSelectionStore.js';
import { RankSelectionStore as DefaultRankSelectionStore } from '#lib/search/flex/RankSelectionStore.js';
import { type RankPoolId, RankPoolStore } from '#lib/search/flex/RankPoolStore.js';
import {
    RankFamilyGraph,
    type RankFamilyEdge,
    type RankFamilyGraphMemoryStats,
    type RankFamilyNodeId
} from '#lib/search/flex/RankFamilyGraph.js';

interface RankFamilyGraphRecord {
    readonly id: number;
    readonly graph: RankFamilyGraph;
}

interface RankFamilyResolvedRecord {
    readonly factorSetId: FactorSetId;
    readonly rankPoolMixId: RankPoolMixId;
    readonly mass: bigint;
}

interface RankFamilyResidueBucket {
    readonly pools: readonly RankFamilyResiduePool[];
}

interface RankFamilyResiduePool {
    readonly rankPoolId: RankPoolId;
    readonly numerator: bigint;
}

interface RankFamilyResidueRecord {
    readonly denominator: bigint;
    readonly buckets: readonly (RankFamilyResidueBucket | undefined)[];
    readonly residueMass: bigint;
}

export interface RankFamilyPendingEntry {
    readonly graphId: number;
    readonly nodeId: RankFamilyNodeId;
    readonly factorSetId: FactorSetId;
    readonly rankPoolMixId: RankPoolMixId;
    readonly mass: bigint;
}

export interface RankFamilySearchRunMemoryStats {
    readonly graphCount: number;
    readonly rankPoolCount: number;
    readonly factorCount: number;
    readonly factorSetCount: number;
    readonly rankPoolMixCount: number;
    readonly selectionCount: number;
    readonly pendingCount: number;
    readonly pendingMergeCount: number;
    readonly resolvedCount: number;
    readonly seededMass: bigint;
    readonly pendingMass: bigint;
    readonly resolvedMass: bigint;
    readonly overflowMass: bigint;
    readonly iterations: number;
    readonly lateForwardCount: number;
    readonly roundingLoss: bigint;
    readonly graphs: readonly RankFamilyGraphMemoryStats[];
}

export interface RankFamilySearchRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
    readonly selections?: RankSelectionStore | undefined;
}

/**
 * Seed-stage standalone rank-family runtime.
 *
 * This intentionally does not replace the current Flex runtime. It proves the
 * new ownership split: graphs are keyed by rank family, exact pools are payload,
 * and pending identity uses `(graph,node,factorSet)` instead of exact rank pool.
 */
export class RankFamilySearchRun {
    public readonly rankPools = new RankPoolStore();
    public readonly selections: RankSelectionStore;

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly graphsByFamily = new Map<SearchPoolFamilySignature, RankFamilyGraphRecord>();
    private readonly graphs: RankFamilyGraph[] = [];
    private readonly pendingByKey = new Map<string, RankFamilyPendingEntry>();
    private readonly expandedKeys = new Set<string>();
    private readonly residuesByKey = new Map<string, RankFamilyResidueRecord>();
    private readonly resolvedByFactorSet = new Map<FactorSetId, RankFamilyResolvedRecord>();
    private seededMass = 0n;
    private overflowMass = 0n;
    private pendingMergeCount = 0;
    private iterations = 0;
    private lateForwardCount = 0;
    private roundingLoss = 0n;
    private seeded = false;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: RankFamilySearchRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
        this.selections = options.selections ?? new DefaultRankSelectionStore();
    }

    public seedXp(xp: number): void {
        if (this.seeded) throw new Error('RankFamilySearchRun can only be seeded once. Create a new run for a new cell.');
        this.seeded = true;

        const distribution = this.distributionService.getModifiedLevelDist(
            this.kernel.registry,
            xp,
            this.kernel.enchantability
        );

        let seededMass = 0n;
        for (const [levelText, rootMass] of Object.entries(distribution)) {
            if (rootMass === 0n) continue;
            const level = Number(levelText);
            const pool = this.kernel.getPool(level);
            const graph = this.graphForPool(pool);
            const root = graph.graph.getRootNodeId(level);
            const rankPoolId = this.rankPools.getOrCreate(pool);
            const rankPoolMixId = this.selections.getOrCreateSinglePoolMix(rankPoolId, rootMass);
            this.pushPending(graph.id, root, this.selections.emptyFactorSet, rankPoolMixId, rootMass);
            seededMass += rootMass;
        }

        if (seededMass > PRECISION) throw new Error(`Modified-level distribution overflowed precision by ${seededMass - PRECISION} units.`);
        this.seededMass = seededMass;
    }

    public getPendingEntries(): readonly RankFamilyPendingEntry[] {
        return Object.freeze([...this.pendingByKey.values()]);
    }

    public getResolvedEntries(): ReadonlyMap<SelectionId, bigint> {
        const entries = new Map<SelectionId, bigint>();
        for (const record of this.resolvedByFactorSet.values()) {
            entries.set(
                this.selections.getOrCreateSelection(record.rankPoolMixId, record.factorSetId),
                record.mass
            );
        }
        return entries;
    }

    public getGraph(graphId: number): RankFamilyGraph {
        const graph = this.graphs[graphId];
        if (!graph) throw new Error(`Unknown rank-family graph ID ${graphId}.`);
        return graph;
    }

    public advance(maxSteps = 1): number {
        if (!Number.isInteger(maxSteps) || maxSteps < 0) {
            throw new Error('Rank-family advance step count must be a non-negative integer.');
        }

        let advanced = 0;
        while (advanced < maxSteps && this.step()) {
            advanced++;
        }
        return advanced;
    }

    public getMemoryStats(): RankFamilySearchRunMemoryStats {
        const selectionStats = this.selections.getMemoryStats();
        const pendingMass = sumPendingMass(this.pendingByKey.values());
        const resolvedMass = sumResolvedMass(this.resolvedByFactorSet.values());
        return {
            graphCount: this.graphs.length,
            rankPoolCount: this.rankPools.getMemoryStats().poolCount,
            factorCount: selectionStats.factorCount,
            factorSetCount: selectionStats.factorSetCount,
            rankPoolMixCount: selectionStats.rankPoolMixCount,
            selectionCount: selectionStats.selectionCount,
            pendingCount: this.pendingByKey.size,
            pendingMergeCount: this.pendingMergeCount,
            resolvedCount: this.resolvedByFactorSet.size,
            seededMass: this.seededMass,
            pendingMass,
            resolvedMass,
            overflowMass: this.overflowMass,
            iterations: this.iterations,
            lateForwardCount: this.lateForwardCount,
            roundingLoss: this.roundingLoss,
            graphs: this.graphs.map(graph => graph.getMemoryStats())
        };
    }

    private step(): boolean {
        const current = this.popNextPending();
        if (!current) return false;

        this.expandedKeys.add(current.key);
        this.processEntry(current.key, current.entry);
        this.iterations++;
        this.drainLateForwardEntries();
        return true;
    }

    private processEntry(key: string, entry: RankFamilyPendingEntry): void {
        const graph = this.getGraph(entry.graphId);
        const expansion = graph.getExpansion(entry.nodeId);
        this.assertRankPoolMixTotal(
            this.selections.getRankPoolMix(entry.rankPoolMixId),
            entry.mass
        );
        const split = this.splitByContinueProbability(entry.rankPoolMixId, expansion.probContinue);

        if (split.stopMass > 0n) {
            this.recordResolved(entry.factorSetId, split.stopMixId!, split.stopMass);
        }

        if (split.forwardMass > 0n) {
            if (expansion.terminalReason === 'overflow') {
                this.overflowMass += split.forwardMass;
            } else if (expansion.totalWeight <= 0 || expansion.edges.length === 0) {
                this.recordResolved(entry.factorSetId, split.forwardMixId!, split.forwardMass);
            } else {
                this.forwardMass(
                    key,
                    entry.graphId,
                    entry.factorSetId,
                    split.forwardMixId!,
                    expansion.edges,
                    expansion.totalWeight
                );
            }
        }
    }

    private graphForPool(pool: SearchPool): RankFamilyGraphRecord {
        const existing = this.graphsByFamily.get(pool.familySignature);
        if (existing) return existing;

        const record = Object.freeze({
            id: this.graphs.length,
            graph: new RankFamilyGraph(this.kernel, pool, this.selections)
        });
        this.graphs.push(record.graph);
        this.graphsByFamily.set(pool.familySignature, record);
        return record;
    }

    private popNextPending(): { readonly key: string; readonly entry: RankFamilyPendingEntry } | undefined {
        const selected = this.selectNextPending();
        if (selected) this.pendingByKey.delete(selected.key);
        return selected;
    }

    private selectNextPending(): { readonly key: string; readonly entry: RankFamilyPendingEntry } | undefined {
        let selectedKey: string | undefined;
        let selectedEntry: RankFamilyPendingEntry | undefined;
        for (const [key, entry] of this.pendingByKey.entries()) {
            if (!selectedEntry || entry.mass > selectedEntry.mass) {
                selectedKey = key;
                selectedEntry = entry;
            }
        }

        return selectedKey && selectedEntry ? { key: selectedKey, entry: selectedEntry } : undefined;
    }

    private drainLateForwardEntries(): void {
        while (true) {
            const current = this.selectNextPending();
            if (!current || !this.expandedKeys.has(current.key)) return;

            this.pendingByKey.delete(current.key);
            this.lateForwardCount++;
            this.processEntry(current.key, current.entry);
        }
    }

    private forwardMass(
        sourceKey: string,
        graphId: number,
        currentFactorSetId: FactorSetId,
        sourceMixId: RankPoolMixId,
        edges: readonly RankFamilyEdge[],
        totalWeightNumber: number
    ): void {
        const totalWeight = BigInt(totalWeightNumber);
        const oldResidues = this.residuesByKey.get(sourceKey);
        if (oldResidues && oldResidues.denominator !== totalWeight) {
            throw new Error(`Rank-family residue denominator changed for frontier key ${sourceKey}.`);
        }
        const nextBuckets: (RankFamilyResidueBucket | undefined)[] = [];
        let nextResidueNumerator = 0n;
        const sourceMix = this.selections.getRankPoolMix(sourceMixId);

        for (let index = 0; index < edges.length; index++) {
            const edge = edges[index]!;
            if (edge.weight <= 0) continue;

            const weight = BigInt(edge.weight);
            const oldBucket = oldResidues?.buckets[index];
            const oldResiduesByPool = new Map<RankPoolId, bigint>(
                oldBucket?.pools.map(pool => [pool.rankPoolId, pool.numerator]) ?? []
            );
            const factorSetId = this.selections.appendFactorToSet(currentFactorSetId, edge.factorId);
            const basePools: RankPoolWeight[] = [];
            const promotedPools: RankPoolWeight[] = [];
            const nextResiduePools: RankFamilyResiduePool[] = [];

            for (const pool of sourceMix.pools) {
                const baseNumerator = pool.weight * weight;
                const baseMass = baseNumerator / totalWeight;
                const oldResidue = oldResiduesByPool.get(pool.rankPoolId) ?? 0n;
                oldResiduesByPool.delete(pool.rankPoolId);
                const numerator = baseNumerator + oldResidue;
                const childMass = numerator / totalWeight;
                const promotedMass = childMass - baseMass;
                const edgeResidue = numerator - (childMass * totalWeight);

                if (baseMass > 0n) basePools.push({ rankPoolId: pool.rankPoolId, weight: baseMass });
                if (promotedMass > 0n) promotedPools.push({ rankPoolId: pool.rankPoolId, weight: promotedMass });
                if (edgeResidue > 0n) nextResiduePools.push(Object.freeze({
                    rankPoolId: pool.rankPoolId,
                    numerator: edgeResidue
                }));
            }

            for (const [rankPoolId, numerator] of oldResiduesByPool.entries()) {
                if (numerator > 0n) nextResiduePools.push(Object.freeze({ rankPoolId, numerator }));
            }

            const baseMass = sumRankPoolWeights(basePools);
            if (baseMass > 0n) {
                this.pushPending(
                    graphId,
                    edge.childId,
                    factorSetId,
                    this.selections.getOrCreateRankPoolMix(basePools),
                    baseMass
                );
            }

            const promotedMass = sumRankPoolWeights(promotedPools);
            if (promotedMass > 0n) {
                this.pushPending(
                    graphId,
                    edge.childId,
                    factorSetId,
                    this.selections.getOrCreateRankPoolMix(promotedPools),
                    promotedMass
                );
            }

            const edgeResidue = sumResidueNumerators(nextResiduePools);
            if (edgeResidue > 0n) {
                nextBuckets[index] = Object.freeze({
                    pools: Object.freeze(nextResiduePools)
                });
                nextResidueNumerator += edgeResidue;
            }
        }

        const oldResidueMass = oldResidues?.residueMass ?? 0n;
        const newResidueMass = nextResidueNumerator / totalWeight;
        if (nextResidueNumerator > 0n) {
            this.residuesByKey.set(sourceKey, Object.freeze({
                denominator: totalWeight,
                buckets: Object.freeze(nextBuckets),
                residueMass: newResidueMass
            }));
        } else {
            this.residuesByKey.delete(sourceKey);
        }
        this.roundingLoss += newResidueMass - oldResidueMass;
    }

    private pushPending(
        graphId: number,
        nodeId: RankFamilyNodeId,
        factorSetId: FactorSetId,
        rankPoolMixId: RankPoolMixId,
        mass: bigint
    ): void {
        if (mass === 0n) return;
        const key = createPendingKey(graphId, nodeId, factorSetId);
        const existing = this.pendingByKey.get(key);
        if (!existing) {
            this.pendingByKey.set(key, Object.freeze({ graphId, nodeId, factorSetId, rankPoolMixId, mass }));
            return;
        }

        this.pendingMergeCount++;
        this.pendingByKey.set(key, Object.freeze({
            graphId,
            nodeId,
            factorSetId,
            rankPoolMixId: this.selections.mergeRankPoolMixes([existing.rankPoolMixId, rankPoolMixId]),
            mass: existing.mass + mass
        }));
    }

    private recordResolved(factorSetId: FactorSetId, rankPoolMixId: RankPoolMixId, mass: bigint): void {
        const scaledMixId = this.selections.scaleRankPoolMix(rankPoolMixId, mass);
        const existing = this.resolvedByFactorSet.get(factorSetId);
        if (!existing) {
            this.resolvedByFactorSet.set(factorSetId, Object.freeze({ factorSetId, rankPoolMixId: scaledMixId, mass }));
            return;
        }

        this.resolvedByFactorSet.set(factorSetId, Object.freeze({
            factorSetId,
            rankPoolMixId: this.selections.mergeRankPoolMixes([existing.rankPoolMixId, scaledMixId]),
            mass: existing.mass + mass
        }));
    }

    private splitByContinueProbability(
        rankPoolMixId: RankPoolMixId,
        probContinue: bigint
    ): {
        readonly stopMixId: RankPoolMixId | undefined;
        readonly stopMass: bigint;
        readonly forwardMixId: RankPoolMixId | undefined;
        readonly forwardMass: bigint;
    } {
        const stopProbability = PRECISION - probContinue;
        const mix = this.selections.getRankPoolMix(rankPoolMixId);
        const stopPools: RankPoolWeight[] = [];
        const forwardPools: RankPoolWeight[] = [];

        for (const pool of mix.pools) {
            const stopMass = ProbUtils.scale(pool.weight, stopProbability);
            const forwardMass = pool.weight - stopMass;
            if (stopMass > 0n) stopPools.push({ rankPoolId: pool.rankPoolId, weight: stopMass });
            if (forwardMass > 0n) forwardPools.push({ rankPoolId: pool.rankPoolId, weight: forwardMass });
        }

        const stopMass = sumRankPoolWeights(stopPools);
        const forwardMass = sumRankPoolWeights(forwardPools);
        return {
            stopMixId: stopMass > 0n ? this.selections.getOrCreateRankPoolMix(stopPools) : undefined,
            stopMass,
            forwardMixId: forwardMass > 0n ? this.selections.getOrCreateRankPoolMix(forwardPools) : undefined,
            forwardMass
        };
    }

    private assertRankPoolMixTotal(mix: RankPoolMix, expected: bigint): void {
        if (mix.totalWeight !== expected) {
            throw new Error(`Rank-family mix total ${mix.totalWeight} does not match expected mass ${expected}.`);
        }
    }
}

function createPendingKey(graphId: number, nodeId: RankFamilyNodeId, factorSetId: FactorSetId): string {
    return `${graphId}:${String(nodeId)}:${String(factorSetId)}`;
}

function sumPendingMass(entries: Iterable<RankFamilyPendingEntry>): bigint {
    let mass = 0n;
    for (const entry of entries) mass += entry.mass;
    return mass;
}

function sumResolvedMass(entries: Iterable<RankFamilyResolvedRecord>): bigint {
    let mass = 0n;
    for (const entry of entries) mass += entry.mass;
    return mass;
}

function sumRankPoolWeights(pools: readonly RankPoolWeight[]): bigint {
    let mass = 0n;
    for (const pool of pools) mass += pool.weight;
    return mass;
}

function sumResidueNumerators(pools: readonly RankFamilyResiduePool[]): bigint {
    let numerator = 0n;
    for (const pool of pools) numerator += pool.numerator;
    return numerator;
}
