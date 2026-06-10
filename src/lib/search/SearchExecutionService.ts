import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchResult, SequentialCheckpointSearchContext, CheckpointSearchContext, EngineInstrumentation, SearchTiming } from '#types/index.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import {
    FlexSearchProjector,
    FlexSearchRun,
    FlexSearchSnapshotBuilder,
    type FlexSearchNativeCheckpoint,
    type FlexSearchRunState,
    type FlexSearchRunMemoryStats
} from '#lib/search/flex/index.js';
import { FLEX_RUN_CACHE_LIMITS } from '#lib/search/flex/FlexConstants.js';
import { ProbUtils } from '#utils/index.js';
import { LRUCache } from '#utils/collections/LRUCache.js';

/**
 * Engine-facing service that advances shared search runs to checkpoint boundaries.
 *
 * It owns run lookup/resume, checkpoint sequencing, instrumentation, and timing.
 * The Flex search runtime owns probability flow; higher-level services
 * own public summary and UI projection.
 */
export class SearchExecutionService {
    private readonly flexSearchRunCache = new LRUCache<string, FlexSearchRun>(FLEX_RUN_CACHE_LIMITS.RUNS);
    private flexSearchRunCacheHits = 0;
    private flexSearchRunCacheMisses = 0;

    public constructor(
        private readonly distributionService: ModifiedLevelDistributionService = new ModifiedLevelDistributionService()
    ) {}

    /** Clears all cached invariant checks and resumable runs owned by this service. */
    public clearCache(): void {
        this.flexSearchRunCache.clear();
        this.flexSearchRunCacheHits = 0;
        this.flexSearchRunCacheMisses = 0;
    }

    /** Advances one request to its next checkpoint or final stop condition. */
    public async searchToCheckpoint(request: CheckpointSearchContext): Promise<SearchResult> {
        const timingStart = request.timing ? performance.now() : 0;
        this.throwIfAborted(request.signal);
        const run = this.getFlexSearchRun(request);
        const state = await run.searchToCheckpointStateAsync({
            threshold: request.exhaustive ? 0n : request.threshold ?? 0n,
            maxIterations: request.exhaustive ? undefined : request.maxIterations,
            drainEqualMassBand: request.drainEqualMassBand,
            exhaustive: request.exhaustive,
            targetClassifiedMass: request.exhaustive ? undefined : request.targetClassifiedMass,
            probabilityFloor: request.probabilityFloor,
            signal: request.signal
        });
        const checkpoint = this.buildFlexSearchCheckpoint(request, run, state);
        this.finishTiming(request.timing, timingStart, 0);
        return this.toFlexSearchResult(checkpoint, state, run.getMemoryStats(), request.exhaustive ? 0n : request.threshold ?? 0n, request.instrumentation, request.timing);
    }

    /** Advances one run through an ordered checkpoint plan, streaming each completed boundary. */
    public async searchSequentialCheckpoints(request: SequentialCheckpointSearchContext): Promise<SearchResult> {
        const timingStart = request.timing ? performance.now() : 0;
        let recordedSearchMs = 0;
        this.throwIfAborted(request.signal);
        const run = this.getFlexSearchRun(request);
        let lastResult: SearchResult | undefined;

        for (let checkpointIndex = 0; checkpointIndex < request.checkpoints.length; checkpointIndex++) {
            if (request.signal?.aborted) break;

            const checkpoint = request.checkpoints[checkpointIndex];
            if (!checkpoint) continue;

            let state: FlexSearchRunState;
            try {
                state = await run.searchToCheckpointStateAsync({
                    threshold: checkpoint.threshold,
                    maxIterations: checkpoint.limit,
                    drainEqualMassBand: request.drainEqualMassBand,
                    targetClassifiedMass: checkpoint.targetClassifiedMass,
                    probabilityFloor: request.probabilityFloor,
                    signal: request.signal
                });
            } catch (error) {
                if (request.signal?.aborted && lastResult) return lastResult;
                throw error;
            }
            const nativeCheckpoint = this.buildFlexSearchCheckpoint(request, run, state);
            recordedSearchMs = this.finishTiming(request.timing, timingStart, recordedSearchMs);
            lastResult = this.toFlexSearchResult(nativeCheckpoint, state, run.getMemoryStats(), checkpoint.threshold, request.instrumentation, request.timing);
            request.onCheckpointComplete(lastResult, checkpointIndex);
        }

        if (lastResult) return lastResult;

        this.finishTiming(request.timing, timingStart, recordedSearchMs);
        const state = run.state();
        const checkpoint = this.buildFlexSearchCheckpoint(request, run, state);
        return this.toFlexSearchResult(checkpoint, state, run.getMemoryStats(), 0, request.instrumentation, request.timing);
    }

    private getFlexSearchRun(request: CheckpointSearchContext): FlexSearchRun {
        const create = () => this.createFlexSearchRun(request);
        if (request.useCache === false) return create();

        const key = this.createRunCacheKey(request);
        const cached = this.flexSearchRunCache.get(key);
        if (cached) {
            this.flexSearchRunCacheHits++;
            return cached;
        }

        this.flexSearchRunCacheMisses++;
        const run = create();
        this.flexSearchRunCache.set(key, run);
        return run;
    }

    private createFlexSearchRun(request: CheckpointSearchContext): FlexSearchRun {
        const run = new FlexSearchRun(this.createKernel(request), {
            distributionService: this.distributionService,
            targetClueId: request.targetClueId
        });
        run.seedXp(request.xp);
        return run;
    }

    private buildFlexSearchCheckpoint(
        request: CheckpointSearchContext,
        run: FlexSearchRun,
        state: FlexSearchRunState
    ): FlexSearchNativeCheckpoint {
        const projector = new FlexSearchProjector(run.rankPools, run.selections, request.registry.enchantToIndex, {
            applyBookRemoval: request.item === 'book',
            targetClueId: request.targetClueId,
            indexToEnchant: request.registry.indexToEnchant
        });
        return new FlexSearchSnapshotBuilder(
            run,
            projector,
            request.registry.indexToEnchant
        ).build(state);
    }

    private createKernel(request: CheckpointSearchContext): RegistryKernel {
        return new RegistryKernel({
            registry: request.registry,
            item: request.item,
            material: request.material
        });
    }

    private createRunCacheKey(request: CheckpointSearchContext): string {
        return JSON.stringify({
            schema: 1,
            version: request.registry.version,
            item: request.item,
            material: request.material,
            xp: request.xp,
            targetClueId: request.targetClueId ?? null
        });
    }

    private toFlexSearchResult(
        checkpoint: FlexSearchNativeCheckpoint,
        state: FlexSearchRunState,
        memory: FlexSearchRunMemoryStats,
        threshold: number | bigint | undefined,
        instrumentation?: EngineInstrumentation | undefined,
        timing?: SearchTiming | undefined
    ): SearchResult {
        const snapshot = checkpoint.snapshot;
        const thresholdUnits = ProbUtils.toBigInt(threshold ?? 0);

        if (instrumentation) {
            instrumentation.totalIterations = snapshot.iterations;
            instrumentation.totalPrunedNodes = 0;
            instrumentation.roundingErrorEvents = snapshot.mass.rounding > 0 ? 1 : 0;
            instrumentation.levelsProcessed = snapshot.graphCount;
            instrumentation.levelsFullyResolved = snapshot.fullyResolved ? snapshot.graphCount : 0;
            instrumentation.fullyResolved = snapshot.fullyResolved;
            instrumentation.resultsSize = snapshot.results.size;
            instrumentation.queueSize = snapshot.pendingCount;
            instrumentation.exitReason = state.exitReason ?? (snapshot.fullyResolved ? 'empty' : 'iterations');
            instrumentation.poolCache = instrumentation.poolCache ?? { hits: 0, misses: 0 };
            instrumentation.distCache = instrumentation.distCache ?? { hits: 0, misses: 0 };
            instrumentation.search = {
                graphCount: snapshot.graphCount,
                seededLevelCount: memory.rankPoolCount,
                pendingEntryCount: snapshot.pendingCount,
                largestPendingMass: ProbUtils.toNumber(snapshot.largestPendingMass),
                lastExpandedMass: ProbUtils.toNumber(snapshot.lastExpandedMass),
                activeResidueCount: snapshot.activeResidueCount,
                activeResidueMass: ProbUtils.toNumber(snapshot.activeResidueMass),
                canImprove: !snapshot.fullyResolved && snapshot.largestPendingMass >= thresholdUnits,
                runCacheHits: this.flexSearchRunCacheHits,
                runCacheMisses: this.flexSearchRunCacheMisses,
                exactPoolCount: memory.rankPoolCount,
                sharedGraphCount: memory.graphCount,
                mergedPoolCount: memory.rankPoolCount - memory.graphCount,
                factorCount: memory.factorCount,
                factorSetCount: memory.factorSetCount,
                rankPoolMixCount: memory.rankPoolMixCount,
                selectionCount: memory.selectionCount,
                pendingMergeCount: memory.pendingMergeCount,
                lateForwardCount: memory.lateForwardCount,
                searchRoundingLoss: ProbUtils.toNumber(memory.roundingLoss),
                projectionLoss: ProbUtils.toNumber(checkpoint.projectionLoss)
            };
        }

        return {
            snapshot,
            combos: new Map(snapshot.results),
            instrumentation: instrumentation ? { ...instrumentation } : undefined,
            timing: timing ? { ...timing } : undefined,
            threshold: ProbUtils.toNumber(threshold ?? 0)
        };
    }

    private throwIfAborted(signal: AbortSignal | undefined): void {
        if (!signal?.aborted) return;
        throw new Error('Aborted');
    }

    private finishTiming(timing: SearchTiming | undefined, start: number, alreadyRecordedForCall: number): number {
        if (!timing) return alreadyRecordedForCall;
        const elapsed = performance.now() - start;
        const delta = Math.max(0, elapsed - alreadyRecordedForCall);
        timing.searchMs = (timing.searchMs ?? 0) + delta;
        timing.totalMs = (timing.totalMs ?? 0) + delta;
        return elapsed;
    }
}
