import { ENGINE_LIMITS } from '#constants/engine.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { NodeIdSearchFrontier } from '#engine/search/NodeIdSearchFrontier.js';
import { SearchNodeGraph } from '#engine/search/SearchNodeGraph.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchResult, SequentialCheckpointSearchContext, CheckpointSearchContext, EngineInstrumentation, SearchTiming, SearchFrontierSnapshot } from '#types/index.js';
import { RegistryKernel } from '#lib/v7/registry/RegistryKernel.js';
import { SearchRun, V7SearchRunSnapshot } from '#lib/v7/search/SearchRun.js';
import { V7SearchCache } from '#lib/v7/search/V7SearchCache.js';
import { PRECISION, ProbUtils } from '#utils/index.js';

/**
 * V7 adapter for the existing engine boundary.
 *
 * This intentionally returns the existing SearchResult shape so SummaryService,
 * SnapshotService, and workers can be migrated before their public contracts move.
 */
export class V7SearchService {
    public constructor(
        private readonly distributionService: ModifiedLevelDistributionService = new ModifiedLevelDistributionService(),
        private readonly cache: V7SearchCache = new V7SearchCache()
    ) {}

    public clearCache(): void {
        this.cache.clearAll();
    }

    public async searchToCheckpoint(request: CheckpointSearchContext): Promise<SearchResult> {
        const timingStart = request.timing ? performance.now() : 0;
        let recordedSearchMs = 0;
        const run = this.getRun(request);
        const snapshot = await run.searchToCheckpointAsync({
            threshold: request.threshold ?? ENGINE_LIMITS.DEFAULT_THRESHOLD,
            maxIterations: request.maxIterations ?? ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED,
            signal: request.signal
        });

        recordedSearchMs = this.finishTiming(request.timing, timingStart, recordedSearchMs);
        return this.toSearchResult(snapshot, request.threshold, request.instrumentation, request.timing);
    }

    public async searchSequentialCheckpoints(request: SequentialCheckpointSearchContext): Promise<SearchResult> {
        const timingStart = request.timing ? performance.now() : 0;
        let recordedSearchMs = 0;
        const run = this.getRun(request);
        let lastResult: SearchResult | undefined;

        for (let checkpointIndex = 0; checkpointIndex < request.checkpoints.length; checkpointIndex++) {
            if (request.signal?.aborted) break;

            const checkpoint = request.checkpoints[checkpointIndex];
            if (!checkpoint) continue;

            const snapshot = await run.searchToCheckpointAsync({
                threshold: checkpoint.threshold,
                maxIterations: checkpoint.limit,
                signal: request.signal
            });

            recordedSearchMs = this.finishTiming(request.timing, timingStart, recordedSearchMs);
            lastResult = this.toSearchResult(snapshot, checkpoint.threshold, request.instrumentation, request.timing);
            request.onCheckpointComplete(lastResult, checkpointIndex);
        }

        if (lastResult) return lastResult;

        recordedSearchMs = this.finishTiming(request.timing, timingStart, recordedSearchMs);
        const emptySnapshot = run.snapshot();
        return this.toSearchResult(emptySnapshot, 0, request.instrumentation, request.timing);
    }

    private getRun(request: CheckpointSearchContext): SearchRun {
        const create = () => this.createRun(request);
        if (request.useCache === false) return create();
        return this.cache.getOrCreateRun(this.createRunCacheKey(request), create);
    }

    private createRun(request: CheckpointSearchContext): SearchRun {
        const kernel = new RegistryKernel({
            registry: request.registry,
            item: request.item,
            material: request.material
        });
        const run = new SearchRun(kernel, {
            distributionService: this.distributionService,
            targetClueId: request.targetClueId,
            programCache: this.cache
        });
        run.seedXp(request.xp);
        return run;
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

    private toSearchResult(
        snapshot: V7SearchRunSnapshot,
        threshold: number | bigint | undefined,
        instrumentation?: EngineInstrumentation | undefined,
        timing?: SearchTiming | undefined
    ): SearchResult {
        const tracker = new SearchStateTracker({
            resolved: BigInt(snapshot.mass.units!.resolved),
            clueIncompatible: BigInt(snapshot.mass.units!.clueIncompatible),
            pending: BigInt(snapshot.mass.units!.pending),
            sieved: BigInt(snapshot.mass.units!.sieved),
            overflow: BigInt(snapshot.mass.units!.overflow),
            capped: BigInt(snapshot.mass.units!.capped),
            rounding: BigInt(snapshot.mass.units!.rounding),
            recoveredRounding: BigInt(snapshot.mass.units!.recoveredRounding),
            recoveredSieved: BigInt(snapshot.mass.units!.recoveredSieved)
        });

        const thresholdUnits = ProbUtils.toBigInt(threshold ?? 0);
        const frontiers = this.toFrontiers(snapshot);

        if (instrumentation) {
            const cacheMetrics = this.cache.getMetrics();
            instrumentation.totalIterations = snapshot.iterations;
            instrumentation.totalPrunedNodes = 0;
            instrumentation.roundingErrorEvents = snapshot.mass.rounding > 0 ? 1 : 0;
            instrumentation.levelsProcessed = snapshot.seededLevelCount;
            instrumentation.levelsFullyResolved = snapshot.fullyResolved ? snapshot.seededLevelCount : 0;
            instrumentation.fullyResolved = snapshot.fullyResolved;
            instrumentation.resultsSize = snapshot.results.size;
            instrumentation.queueSize = snapshot.pendingCount;
            instrumentation.indexMapSize = snapshot.pendingCount;
            instrumentation.exitReason = snapshot.fullyResolved
                ? 'empty'
                : snapshot.largestPendingMass < thresholdUnits ? 'threshold' : 'iterations';
            instrumentation.poolCache = instrumentation.poolCache ?? { hits: 0, misses: 0 };
            instrumentation.distCache = instrumentation.distCache ?? { hits: 0, misses: 0 };
            instrumentation.frontierCache = instrumentation.frontierCache ?? { hits: 0, misses: 0 };
            instrumentation.v7 = {
                programCount: snapshot.programCount,
                seededLevelCount: snapshot.seededLevelCount,
                pendingEntryCount: snapshot.pendingCount,
                largestPendingMass: ProbUtils.toNumber(snapshot.largestPendingMass),
                activeResidueCount: snapshot.activeResidueCount,
                activeResidueMass: ProbUtils.toNumber(snapshot.activeResidueMass),
                canImprove: !snapshot.fullyResolved && snapshot.largestPendingMass >= thresholdUnits,
                programCacheHits: cacheMetrics.programs.hits,
                programCacheMisses: cacheMetrics.programs.misses,
                runCacheHits: cacheMetrics.runs.hits,
                runCacheMisses: cacheMetrics.runs.misses
            };
        }

        return {
            combos: new Map(snapshot.results),
            tracker,
            frontiers,
            v7Snapshot: snapshot,
            instrumentation: instrumentation ? { ...instrumentation } : undefined,
            timing: timing ? { ...timing } : undefined,
            threshold: ProbUtils.toNumber(threshold ?? 0)
        };
    }

    private toFrontiers(snapshot: V7SearchRunSnapshot): SearchFrontierSnapshot[] {
        if (snapshot.pendingEntries.length === 0) return [];

        const graph = new SearchNodeGraph();
        const frontier = new NodeIdSearchFrontier(snapshot.pendingEntries.length);
        for (const entry of snapshot.pendingEntries) {
            const nodeId = graph.createNumericNode(
                entry.nodeId as number,
                entry.programId,
                0,
                entry.combo,
                entry.count
            );
            frontier.pushOrMerge(nodeId, entry.mass);
        }

        return [{ frontier, graph, scale: PRECISION }];
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
