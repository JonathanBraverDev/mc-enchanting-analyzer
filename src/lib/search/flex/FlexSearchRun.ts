import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import type { EngineExitReason } from '#types/index.js';
import type { MassAccountingBreakdown } from '#types/mass.js';
import { AsyncUtils } from '#utils/async/AsyncUtils.js';
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
    FlexSearchGraph,
    type FlexSearchEdge,
    type FlexSearchGraphStats,
    type FlexSearchNodeId
} from '#lib/search/flex/FlexSearchGraph.js';

interface FlexSearchGraphRecord {
    readonly id: number;
    readonly graph: FlexSearchGraph;
}

interface FlexSearchResolvedRecord {
    readonly factorSetId: FactorSetId;
    readonly rankPoolMixId: RankPoolMixId;
    readonly mass: bigint;
}

interface FlexSearchResidueBucket {
    readonly pools: readonly FlexSearchResiduePool[];
}

interface FlexSearchResiduePool {
    readonly rankPoolId: RankPoolId;
    readonly numerator: bigint;
}

interface FlexSearchResidueRecord {
    readonly denominator: bigint;
    readonly buckets: readonly (FlexSearchResidueBucket | undefined)[];
    readonly residueMass: bigint;
}

export interface FlexSearchPendingEntry {
    readonly graphId: number;
    readonly nodeId: FlexSearchNodeId;
    readonly factorSetId: FactorSetId;
    readonly rankPoolMixId: RankPoolMixId;
    readonly mass: bigint;
}

interface FlexSearchPendingRecord extends FlexSearchPendingEntry {
    readonly key: string;
    readonly sequence: number;
    heapIndex: number;
}

interface FlexSearchPendingInput extends FlexSearchPendingEntry {
    readonly key: string;
}

export interface FlexSearchRunMemoryStats {
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
    readonly sievedMass: bigint;
    readonly overflowMass: bigint;
    readonly iterations: number;
    readonly lastExpandedMass: bigint;
    readonly lateForwardCount: number;
    readonly roundingLoss: bigint;
    readonly activeResidueCount: number;
    readonly activeResidueMass: bigint;
    readonly graphs: readonly FlexSearchGraphStats[];
}

export interface FlexSearchRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
    readonly selections?: RankSelectionStore | undefined;
}

export interface FlexSearchCheckpointRequest {
    readonly threshold?: number | bigint | undefined;
    readonly maxIterations?: number | undefined;
    readonly drainEqualMassBand?: boolean | undefined;
    readonly exhaustive?: boolean | undefined;
    readonly targetClassifiedMass?: number | bigint | undefined;
    readonly probabilityFloor?: number | bigint | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly yieldEveryIterations?: number | undefined;
}

export interface FlexSearchRunState {
    readonly mass: MassAccountingBreakdown;
    readonly iterations: number;
    readonly lastExpandedMass: bigint;
    readonly pendingCount: number;
    readonly largestPendingMass: bigint;
    readonly graphCount: number;
    readonly seededLevelCount: number;
    readonly activeResidueCount: number;
    readonly activeResidueMass: bigint;
    readonly fullyResolved: boolean;
    readonly exitReason: EngineExitReason | undefined;
}

interface FlexSearchAdvanceCriteria {
    readonly threshold: bigint;
    readonly maxIterations: number;
    readonly drainEqualMassBand: boolean;
    readonly targetClassifiedMass: bigint | undefined;
    readonly probabilityFloor: bigint;
    readonly signal?: AbortSignal | undefined;
}

/**
 * Flex search runtime with rank-merge graph sharing.
 *
 * This keeps the V8 Flex ownership model: one weighted frontier owns mass flow,
 * while shared graphs are keyed by future behavior and exact rank pools travel
 * as payloads for projection.
 */
export class FlexSearchRun {
    public readonly rankPools = new RankPoolStore();
    public readonly selections: RankSelectionStore;

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly graphsByFamily = new Map<SearchPoolFamilySignature, FlexSearchGraphRecord>();
    private readonly graphs: FlexSearchGraph[] = [];
    private readonly pending = new FlexSearchFrontier();
    private readonly expandedKeys = new Set<string>();
    private readonly residuesByKey = new Map<string, FlexSearchResidueRecord>();
    private readonly resolvedByFactorSet = new Map<FactorSetId, FlexSearchResolvedRecord>();
    private seededMass = 0n;
    private pendingMass = 0n;
    private resolvedMass = 0n;
    private sievedMass = 0n;
    private overflowMass = 0n;
    private pendingMergeCount = 0;
    private iterations = 0;
    private lastExpandedMass = 0n;
    private lateForwardCount = 0;
    private roundingLoss = 0n;
    private exitReason: EngineExitReason | undefined;
    private seeded = false;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: FlexSearchRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
        this.selections = options.selections ?? new DefaultRankSelectionStore();
    }

    public seedXp(xp: number): void {
        if (this.seeded) throw new Error('FlexSearchRun can only be seeded once. Create a new run for a new cell.');
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

    public getPendingEntries(): readonly FlexSearchPendingEntry[] {
        return Object.freeze([...this.pending.values()]);
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

    public getGraph(graphId: number): FlexSearchGraph {
        const graph = this.graphs[graphId];
        if (!graph) throw new Error(`Unknown Flex search graph ID ${graphId}.`);
        return graph;
    }

    public advance(maxSteps = 1, options: { readonly probabilityFloor?: bigint | undefined } = {}): number {
        if (!Number.isInteger(maxSteps) || maxSteps < 0) {
            throw new Error('Flex search advance step count must be a non-negative integer.');
        }

        let advanced = 0;
        while (advanced < maxSteps && this.step(options.probabilityFloor ?? 0n)) {
            advanced++;
        }
        if (this.pending.size === 0) this.releaseCompletedFrontierState();
        return advanced;
    }

    public searchToCheckpointState(request: FlexSearchCheckpointRequest = {}): FlexSearchRunState {
        const criteria = this.createAdvanceCriteria(request);
        this.advanceUntilCheckpoint(criteria);
        return this.state();
    }

    public async searchToCheckpointStateAsync(request: FlexSearchCheckpointRequest = {}): Promise<FlexSearchRunState> {
        const criteria = this.createAdvanceCriteria(request);
        const chunkIterations = Math.max(
            1,
            request.yieldEveryIterations ?? ENGINE_LIMITS.ASYNC_SEARCH_CHUNK_ITERATIONS
        );

        while (!this.advanceUntilCheckpoint(criteria, chunkIterations)) {
            await AsyncUtils.yield();
        }

        return this.state();
    }

    public state(): FlexSearchRunState {
        const memory = this.getMemoryStats();
        const pending = memory.pendingMass;
        const resolved = memory.resolvedMass;
        const rounding = memory.roundingLoss;
        const mass = Object.freeze({
            resolved: ProbUtils.toNumber(resolved),
            clueIncompatible: 0,
            pending: ProbUtils.toNumber(pending),
            sieved: ProbUtils.toNumber(memory.sievedMass),
            overflow: ProbUtils.toNumber(memory.overflowMass),
            capped: 0,
            rounding: ProbUtils.toNumber(rounding),
            recoveredRounding: 0,
            recoveredSieved: 0,
            units: Object.freeze({
                resolved: resolved.toString(),
                clueIncompatible: '0',
                pending: pending.toString(),
                sieved: memory.sievedMass.toString(),
                overflow: memory.overflowMass.toString(),
                capped: '0',
                rounding: rounding.toString(),
                recoveredRounding: '0',
                recoveredSieved: '0'
            })
        }) satisfies MassAccountingBreakdown;

        return Object.freeze({
            mass,
            iterations: memory.iterations,
            lastExpandedMass: memory.lastExpandedMass,
            pendingCount: memory.pendingCount,
            largestPendingMass: this.pending.peek()?.mass ?? 0n,
            graphCount: memory.graphCount,
            seededLevelCount: memory.rankPoolCount,
            activeResidueCount: memory.activeResidueCount,
            activeResidueMass: memory.activeResidueMass,
            fullyResolved: memory.pendingCount === 0,
            exitReason: this.exitReason
        });
    }

    public getMemoryStats(): FlexSearchRunMemoryStats {
        const selectionStats = this.selections.getMemoryStats();
        return {
            graphCount: this.graphs.length,
            rankPoolCount: this.rankPools.getMemoryStats().poolCount,
            factorCount: selectionStats.factorCount,
            factorSetCount: selectionStats.factorSetCount,
            rankPoolMixCount: selectionStats.rankPoolMixCount,
            selectionCount: selectionStats.selectionCount,
            pendingCount: this.pending.size,
            pendingMergeCount: this.pendingMergeCount,
            resolvedCount: this.resolvedByFactorSet.size,
            seededMass: this.seededMass,
            pendingMass: this.pendingMass,
            resolvedMass: this.resolvedMass,
            sievedMass: this.sievedMass,
            overflowMass: this.overflowMass,
            iterations: this.iterations,
            lastExpandedMass: this.lastExpandedMass,
            lateForwardCount: this.lateForwardCount,
            roundingLoss: this.roundingLoss,
            activeResidueCount: this.residuesByKey.size,
            activeResidueMass: sumResidueMass(this.residuesByKey.values()),
            graphs: this.graphs.map(graph => graph.getMemoryStats())
        };
    }

    private createAdvanceCriteria(request: FlexSearchCheckpointRequest): FlexSearchAdvanceCriteria {
        const targetClassifiedMass = request.targetClassifiedMass === undefined
            ? undefined
            : ProbUtils.toBigInt(request.targetClassifiedMass);
        const threshold = request.exhaustive ? 0n : ProbUtils.toBigInt(request.threshold ?? 0n);
        const maxIterations = request.exhaustive
            ? Number.POSITIVE_INFINITY
            : request.maxIterations ?? Number.POSITIVE_INFINITY;
        const probabilityFloor = request.exhaustive
            ? 0n
            : request.probabilityFloor !== undefined
                ? ProbUtils.toBigInt(request.probabilityFloor)
                : ProbUtils.toBigInt(ENGINE_LIMITS.SYSTEM_THRESHOLD_FLOOR);
        const hasBoundedStopCondition = targetClassifiedMass !== undefined
            || (request.threshold !== undefined && threshold > 0n)
            || request.maxIterations !== undefined;

        if (!request.exhaustive && !hasBoundedStopCondition) {
            throw new Error('FlexSearchRun has no bounded stop condition. Provide a positive threshold, a finite maxIterations, a mass target, or set exhaustive: true.');
        }

        return {
            threshold,
            maxIterations,
            drainEqualMassBand: request.exhaustive ? false : request.drainEqualMassBand === true,
            targetClassifiedMass,
            probabilityFloor,
            signal: request.signal
        };
    }

    private advanceUntilCheckpoint(criteria: FlexSearchAdvanceCriteria, chunkIterations?: number): boolean {
        this.exitReason = undefined;
        let advancedInChunk = 0;

        while (true) {
            if (criteria.signal?.aborted) throw new Error('Aborted');
            const exitReason = this.getExitReason(criteria);
            if (exitReason !== undefined) {
                this.exitReason = exitReason;
                return true;
            }
            if (chunkIterations !== undefined && advancedInChunk >= chunkIterations) return false;
            if (!this.step(criteria.probabilityFloor)) {
                this.exitReason = 'empty';
                return true;
            }
            advancedInChunk++;
        }
    }

    private getExitReason(criteria: FlexSearchAdvanceCriteria): EngineExitReason | undefined {
        const pending = this.pending.peek();
        if (!pending) return 'empty';
        if (criteria.targetClassifiedMass !== undefined && this.getClassifiedMass() >= criteria.targetClassifiedMass) return 'mass';
        if (pending.mass < criteria.threshold) return 'threshold';
        if (this.hasReachedIterationStop(criteria, pending.mass)) return 'iterations';
        return undefined;
    }

    private hasReachedIterationStop(criteria: FlexSearchAdvanceCriteria, nextMass: bigint): boolean {
        if (this.iterations < criteria.maxIterations) return false;
        if (!criteria.drainEqualMassBand) return true;
        if (this.lastExpandedMass === 0n) return true;
        return nextMass < this.lastExpandedMass;
    }

    private getClassifiedMass(): bigint {
        return this.seededMass - this.pendingMass;
    }

    private step(probabilityFloor: bigint): boolean {
        const current = this.popNextPending();
        if (!current) return false;

        this.expandedKeys.add(current.key);
        this.lastExpandedMass = current.mass;
        this.processEntry(current.key, current, probabilityFloor);
        this.iterations++;
        this.drainLateForwardEntries(probabilityFloor);
        return true;
    }

    private processEntry(key: string, entry: FlexSearchPendingEntry, probabilityFloor: bigint): void {
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
            } else if (expansion.count > 0 && probabilityFloor > 0n && split.forwardMass < probabilityFloor) {
                this.sievedMass += split.forwardMass;
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

    private graphForPool(pool: SearchPool): FlexSearchGraphRecord {
        const existing = this.graphsByFamily.get(pool.familySignature);
        if (existing) return existing;

        const record = Object.freeze({
            id: this.graphs.length,
            graph: new FlexSearchGraph(this.kernel, pool, this.selections)
        });
        this.graphs.push(record.graph);
        this.graphsByFamily.set(pool.familySignature, record);
        return record;
    }

    private popNextPending(): FlexSearchPendingRecord | undefined {
        const record = this.pending.pop();
        if (record) this.pendingMass -= record.mass;
        return record;
    }

    private selectNextPending(): FlexSearchPendingRecord | undefined {
        return this.pending.peek();
    }

    private drainLateForwardEntries(probabilityFloor: bigint): void {
        while (true) {
            const current = this.selectNextPending();
            if (!current || !this.expandedKeys.has(current.key)) return;

            this.popNextPending();
            this.lateForwardCount++;
            this.processEntry(current.key, current, probabilityFloor);
        }
    }

    private forwardMass(
        sourceKey: string,
        graphId: number,
        currentFactorSetId: FactorSetId,
        sourceMixId: RankPoolMixId,
        edges: readonly FlexSearchEdge[],
        totalWeightNumber: number
    ): void {
        const totalWeight = BigInt(totalWeightNumber);
        const oldResidues = this.residuesByKey.get(sourceKey);
        if (oldResidues && oldResidues.denominator !== totalWeight) {
            throw new Error(`Flex residue denominator changed for frontier key ${sourceKey}.`);
        }
        const nextBuckets: (FlexSearchResidueBucket | undefined)[] = [];
        let nextResidueNumerator = 0n;
        const sourceMix = this.selections.getRankPoolMix(sourceMixId);

        for (let index = 0; index < edges.length; index++) {
            const edge = edges[index]!;
            if (edge.weight <= 0) continue;

            const weight = BigInt(edge.weight);
            const oldBucket = oldResidues?.buckets[index];
            const oldResiduePools = oldBucket?.pools ?? [];
            let oldResidueIndex = 0;
            const factorSetId = this.selections.appendFactorToSet(currentFactorSetId, edge.factorId);
            const basePools: RankPoolWeight[] = [];
            const promotedPools: RankPoolWeight[] = [];
            const nextResiduePools: FlexSearchResiduePool[] = [];

            for (const pool of sourceMix.pools) {
                while (
                    oldResidueIndex < oldResiduePools.length
                    && oldResiduePools[oldResidueIndex]!.rankPoolId < pool.rankPoolId
                ) {
                    const staleResidue = oldResiduePools[oldResidueIndex]!;
                    if (staleResidue.numerator > 0n) nextResiduePools.push(staleResidue);
                    oldResidueIndex++;
                }

                const baseNumerator = pool.weight * weight;
                const baseMass = baseNumerator / totalWeight;
                const matchingOldResidue = oldResiduePools[oldResidueIndex]?.rankPoolId === pool.rankPoolId
                    ? oldResiduePools[oldResidueIndex]
                    : undefined;
                const oldResidue = matchingOldResidue?.numerator ?? 0n;
                if (matchingOldResidue) oldResidueIndex++;
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

            while (oldResidueIndex < oldResiduePools.length) {
                const staleResidue = oldResiduePools[oldResidueIndex]!;
                if (staleResidue.numerator > 0n) nextResiduePools.push(staleResidue);
                oldResidueIndex++;
            }

            const baseMass = sumRankPoolWeights(basePools);
            const promotedMass = sumRankPoolWeights(promotedPools);
            const childMass = baseMass + promotedMass;
            if (childMass > 0n) {
                this.pushPending(
                    graphId,
                    edge.childId,
                    factorSetId,
                    this.selections.getOrCreateRankPoolMix(
                        promotedMass > 0n ? [...basePools, ...promotedPools] : basePools
                    ),
                    childMass
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
        nodeId: FlexSearchNodeId,
        factorSetId: FactorSetId,
        rankPoolMixId: RankPoolMixId,
        mass: bigint
    ): void {
        if (mass === 0n) return;
        const key = createPendingKey(graphId, nodeId, factorSetId);
        const existing = this.pending.get(key);
        if (!existing) {
            this.pendingMass += mass;
            this.pending.set(Object.freeze({ key, graphId, nodeId, factorSetId, rankPoolMixId, mass }));
            return;
        }

        this.pendingMergeCount++;
        this.pendingMass += mass;
        this.pending.set(Object.freeze({
            key,
            graphId,
            nodeId,
            factorSetId,
            rankPoolMixId: this.selections.mergeRankPoolMixPair(existing.rankPoolMixId, rankPoolMixId),
            mass: existing.mass + mass
        }));
    }

    private recordResolved(factorSetId: FactorSetId, rankPoolMixId: RankPoolMixId, mass: bigint): void {
        this.resolvedMass += mass;
        const scaledMixId = this.selections.scaleRankPoolMix(rankPoolMixId, mass);
        const existing = this.resolvedByFactorSet.get(factorSetId);
        if (!existing) {
            this.resolvedByFactorSet.set(factorSetId, Object.freeze({ factorSetId, rankPoolMixId: scaledMixId, mass }));
            return;
        }

        this.resolvedByFactorSet.set(factorSetId, Object.freeze({
            factorSetId,
            rankPoolMixId: this.selections.mergeRankPoolMixPair(existing.rankPoolMixId, scaledMixId),
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
            throw new Error(`Flex rank-pool mix total ${mix.totalWeight} does not match expected mass ${expected}.`);
        }
    }

    private releaseCompletedFrontierState(): void {
        this.expandedKeys.clear();
        this.residuesByKey.clear();
    }
}

class FlexSearchFrontier {
    private readonly heap: FlexSearchPendingRecord[] = [];
    private readonly recordsByKey = new Map<string, FlexSearchPendingRecord>();
    private nextSequence = 0;

    public get size(): number {
        return this.heap.length;
    }

    public get(key: string): FlexSearchPendingRecord | undefined {
        return this.recordsByKey.get(key);
    }

    public values(): Iterable<FlexSearchPendingRecord> {
        return this.heap.values();
    }

    public peek(): FlexSearchPendingRecord | undefined {
        return this.heap[0];
    }

    public pop(): FlexSearchPendingRecord | undefined {
        const first = this.heap[0];
        if (!first) return undefined;

        const last = this.heap.pop()!;
        this.recordsByKey.delete(first.key);
        if (this.heap.length > 0) {
            this.heap[0] = last;
            last.heapIndex = 0;
            this.sinkDown(0);
        }
        return first;
    }

    public set(record: FlexSearchPendingInput): void {
        const existing = this.recordsByKey.get(record.key);
        if (!existing) {
            const pendingRecord = {
                ...record,
                sequence: this.nextSequence++,
                heapIndex: this.heap.length
            };
            this.heap.push(pendingRecord);
            this.recordsByKey.set(record.key, pendingRecord);
            this.bubbleUp(pendingRecord.heapIndex);
            return;
        }

        const previousMass = existing.mass;
        const updated = {
            ...record,
            sequence: existing.sequence,
            heapIndex: existing.heapIndex
        };
        this.heap[existing.heapIndex] = updated;
        this.recordsByKey.set(record.key, updated);
        if (updated.mass >= previousMass) {
            this.bubbleUp(updated.heapIndex);
        } else {
            this.sinkDown(updated.heapIndex);
        }
    }

    private bubbleUp(position: number): void {
        let current = position;
        while (current > 0) {
            const parent = Math.floor((current - 1) / 2);
            if (comparePendingRecords(this.heap[parent]!, this.heap[current]!) >= 0) return;
            this.swap(parent, current);
            current = parent;
        }
    }

    private sinkDown(position: number): void {
        let current = position;
        while (true) {
            const left = current * 2 + 1;
            const right = left + 1;
            let largest = current;

            if (left < this.heap.length && comparePendingRecords(this.heap[left]!, this.heap[largest]!) > 0) {
                largest = left;
            }
            if (right < this.heap.length && comparePendingRecords(this.heap[right]!, this.heap[largest]!) > 0) {
                largest = right;
            }
            if (largest === current) return;

            this.swap(current, largest);
            current = largest;
        }
    }

    private swap(left: number, right: number): void {
        const leftRecord = this.heap[left]!;
        const rightRecord = this.heap[right]!;
        this.heap[left] = rightRecord;
        this.heap[right] = leftRecord;
        rightRecord.heapIndex = left;
        leftRecord.heapIndex = right;
    }
}

function comparePendingRecords(left: FlexSearchPendingRecord, right: FlexSearchPendingRecord): number {
    if (left.mass > right.mass) return 1;
    if (left.mass < right.mass) return -1;
    if (left.sequence < right.sequence) return 1;
    if (left.sequence > right.sequence) return -1;
    return 0;
}

function createPendingKey(graphId: number, nodeId: FlexSearchNodeId, factorSetId: FactorSetId): string {
    return `${graphId}:${String(nodeId)}:${String(factorSetId)}`;
}

function sumRankPoolWeights(pools: readonly RankPoolWeight[]): bigint {
    let mass = 0n;
    for (const pool of pools) mass += pool.weight;
    return mass;
}

function sumResidueNumerators(pools: readonly FlexSearchResiduePool[]): bigint {
    let numerator = 0n;
    for (const pool of pools) numerator += pool.numerator;
    return numerator;
}

function sumResidueMass(entries: Iterable<FlexSearchResidueRecord>): bigint {
    let mass = 0n;
    for (const entry of entries) mass += entry.residueMass;
    return mass;
}
