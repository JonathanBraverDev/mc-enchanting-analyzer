import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { PRECISION, ProbUtils } from '#utils/index.js';
import type { SearchPool, SearchPoolFamilySignature } from '#lib/search/registry/RegistryKernel.js';
import type { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import {
    type FactorSetId,
    type RankPoolMixId,
    type RankSelectionStore,
    type SelectionId
} from '#lib/search/flex/RankSelectionStore.js';
import { RankSelectionStore as DefaultRankSelectionStore } from '#lib/search/flex/RankSelectionStore.js';
import { RankPoolStore } from '#lib/search/flex/RankPoolStore.js';
import { RankFamilyGraph, type RankFamilyGraphMemoryStats, type RankFamilyNodeId } from '#lib/search/flex/RankFamilyGraph.js';

interface RankFamilyGraphRecord {
    readonly id: number;
    readonly graph: RankFamilyGraph;
}

interface RankFamilyResolvedRecord {
    readonly factorSetId: FactorSetId;
    readonly rankPoolMixId: RankPoolMixId;
    readonly mass: bigint;
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
    readonly iterations: number;
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
    private readonly resolvedByFactorSet = new Map<FactorSetId, RankFamilyResolvedRecord>();
    private seededMass = 0n;
    private pendingMergeCount = 0;
    private iterations = 0;
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
            iterations: this.iterations,
            roundingLoss: this.roundingLoss,
            graphs: this.graphs.map(graph => graph.getMemoryStats())
        };
    }

    private step(): boolean {
        const current = this.popNextPending();
        if (!current) return false;

        const graph = this.getGraph(current.graphId);
        const expansion = graph.getExpansion(current.nodeId);
        const stopMass = ProbUtils.scale(current.mass, PRECISION - expansion.probContinue);
        const forwardMass = current.mass - stopMass;

        if (stopMass > 0n) {
            this.recordResolved(current.factorSetId, current.rankPoolMixId, stopMass);
        }

        if (forwardMass > 0n) {
            if (expansion.terminalReason !== null || expansion.totalWeight <= 0 || expansion.edges.length === 0) {
                this.recordResolved(current.factorSetId, current.rankPoolMixId, forwardMass);
            } else {
                const childMasses = splitMassByWeights(
                    forwardMass,
                    expansion.edges.map(edge => edge.weight),
                    BigInt(expansion.totalWeight)
                );
                let assigned = 0n;
                for (let index = 0; index < expansion.edges.length; index++) {
                    const childMass = childMasses[index]!;
                    if (childMass === 0n) continue;
                    const edge = expansion.edges[index]!;
                    const factorSetId = this.selections.appendFactorToSet(current.factorSetId, edge.factorId);
                    const rankPoolMixId = this.selections.scaleRankPoolMix(current.rankPoolMixId, childMass);
                    this.pushPending(current.graphId, edge.childId, factorSetId, rankPoolMixId, childMass);
                    assigned += childMass;
                }
                this.roundingLoss += forwardMass - assigned;
            }
        }

        this.iterations++;
        return true;
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

    private popNextPending(): RankFamilyPendingEntry | undefined {
        let selectedKey: string | undefined;
        let selectedEntry: RankFamilyPendingEntry | undefined;
        for (const [key, entry] of this.pendingByKey.entries()) {
            if (!selectedEntry || entry.mass > selectedEntry.mass) {
                selectedKey = key;
                selectedEntry = entry;
            }
        }

        if (selectedKey) this.pendingByKey.delete(selectedKey);
        return selectedEntry;
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

function splitMassByWeights(mass: bigint, weights: readonly number[], totalWeight: bigint): bigint[] {
    const split = weights.map((weight, index) => {
        const scaledNumerator = mass * BigInt(weight);
        return {
            index,
            mass: scaledNumerator / totalWeight,
            remainder: scaledNumerator % totalWeight
        };
    });

    let assigned = split.reduce((sum, entry) => sum + entry.mass, 0n);
    let remainder = mass - assigned;
    const remainderOrder = [...split].sort((left, right) => {
        if (left.remainder === right.remainder) return left.index - right.index;
        return left.remainder > right.remainder ? -1 : 1;
    });

    for (const entry of remainderOrder) {
        if (remainder === 0n) break;
        entry.mass++;
        assigned++;
        remainder--;
    }

    if (assigned !== mass) throw new Error(`Rank-family advance lost ${mass - assigned} mass units.`);
    return split
        .sort((left, right) => left.index - right.index)
        .map(entry => entry.mass);
}
