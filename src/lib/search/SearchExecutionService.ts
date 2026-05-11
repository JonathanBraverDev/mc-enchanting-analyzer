import { ENGINE_LIMITS } from '#constants/engine.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchResult, SequentialCheckpointSearchContext, CheckpointSearchContext, EngineInstrumentation, SearchTiming } from '#types/index.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { SearchRun, SearchRunSnapshot } from '#lib/search/SearchRun.js';
import { SearchStateCache } from '#lib/search/SearchStateCache.js';
import { PRECISION, ProbUtils } from '#utils/index.js';

/**
 * Engine-facing service that advances shared search runs to checkpoint boundaries.
 *
 * It owns run lookup/resume, checkpoint sequencing, instrumentation, and timing.
 * Lower-level `SearchRun` owns probability flow; higher-level services own public
 * summary and UI projection.
 */
export class SearchExecutionService {
    public constructor(
        private readonly distributionService: ModifiedLevelDistributionService = new ModifiedLevelDistributionService(),
        private readonly cache: SearchStateCache = new SearchStateCache()
    ) {}

    /** Clears all cached structural graphs and resumable runs owned by this service. */
    public clearCache(): void {
        this.cache.clearAll();
    }

    /** Advances one request to its next checkpoint or final stop condition. */
    public async searchToCheckpoint(request: CheckpointSearchContext): Promise<SearchResult> {
        const timingStart = request.timing ? performance.now() : 0;
        let recordedSearchMs = 0;
        const run = this.getRun(request);
        const snapshot = await run.searchToCheckpointAsync({
            threshold: request.exhaustive ? 0n : request.threshold ?? ENGINE_LIMITS.DEFAULT_THRESHOLD,
            maxIterations: request.exhaustive ? undefined : request.maxIterations ?? ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED,
            exhaustive: request.exhaustive,
            targetClassifiedMass: request.exhaustive ? undefined : request.targetClassifiedMass,
            signal: request.signal
        });

        recordedSearchMs = this.finishTiming(request.timing, timingStart, recordedSearchMs);
        return this.toSearchResult(snapshot, request.exhaustive ? 0n : request.threshold, request.targetClassifiedMass, request.instrumentation, request.timing);
    }

    /** Advances one run through an ordered checkpoint plan, streaming each completed boundary. */
    public async searchSequentialCheckpoints(request: SequentialCheckpointSearchContext): Promise<SearchResult> {
        const timingStart = request.timing ? performance.now() : 0;
        let recordedSearchMs = 0;
        const run = this.getRun(request);
        let lastResult: SearchResult | undefined;

        for (let checkpointIndex = 0; checkpointIndex < request.checkpoints.length; checkpointIndex++) {
            if (request.signal?.aborted) break;

            const checkpoint = request.checkpoints[checkpointIndex];
            if (!checkpoint) continue;

            let snapshot: SearchRunSnapshot;
            try {
                snapshot = await run.searchToCheckpointAsync({
                    threshold: checkpoint.threshold,
                    maxIterations: checkpoint.limit,
                    targetClassifiedMass: checkpoint.targetClassifiedMass,
                    signal: request.signal
                });
            } catch (error) {
                if (request.signal?.aborted && lastResult) return lastResult;
                throw error;
            }

            recordedSearchMs = this.finishTiming(request.timing, timingStart, recordedSearchMs);
            lastResult = this.toSearchResult(snapshot, checkpoint.threshold, checkpoint.targetClassifiedMass, request.instrumentation, request.timing);
            request.onCheckpointComplete(lastResult, checkpointIndex);
        }

        if (lastResult) return lastResult;

        recordedSearchMs = this.finishTiming(request.timing, timingStart, recordedSearchMs);
        const emptySnapshot = run.snapshot();
        return this.toSearchResult(emptySnapshot, 0, undefined, request.instrumentation, request.timing);
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
            graphCache: this.cache
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
        snapshot: SearchRunSnapshot,
        threshold: number | bigint | undefined,
        targetClassifiedMass?: number | bigint | undefined,
        instrumentation?: EngineInstrumentation | undefined,
        timing?: SearchTiming | undefined
    ): SearchResult {
        const thresholdUnits = ProbUtils.toBigInt(threshold ?? 0);
        const targetClassifiedMassUnits = targetClassifiedMass === undefined
            ? undefined
            : ProbUtils.toBigInt(targetClassifiedMass);
        const pendingUnits = BigInt(snapshot.mass.units?.pending ?? 0);
        const classifiedMassUnits = PRECISION - pendingUnits;

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
            instrumentation.exitReason = snapshot.fullyResolved
                ? 'empty'
                : targetClassifiedMassUnits !== undefined && classifiedMassUnits >= targetClassifiedMassUnits
                    ? 'mass'
                    : snapshot.largestPendingMass < thresholdUnits ? 'threshold' : 'iterations';
            instrumentation.poolCache = instrumentation.poolCache ?? { hits: 0, misses: 0 };
            instrumentation.distCache = instrumentation.distCache ?? { hits: 0, misses: 0 };
            instrumentation.search = {
                graphCount: snapshot.graphCount,
                seededLevelCount: snapshot.seededLevelCount,
                pendingEntryCount: snapshot.pendingCount,
                largestPendingMass: ProbUtils.toNumber(snapshot.largestPendingMass),
                lastExpandedMass: ProbUtils.toNumber(snapshot.lastExpandedMass),
                activeResidueCount: snapshot.activeResidueCount,
                activeResidueMass: ProbUtils.toNumber(snapshot.activeResidueMass),
                canImprove: !snapshot.fullyResolved && snapshot.largestPendingMass >= thresholdUnits,
                graphCacheHits: cacheMetrics.graphs.hits,
                graphCacheMisses: cacheMetrics.graphs.misses,
                runCacheHits: cacheMetrics.runs.hits,
                runCacheMisses: cacheMetrics.runs.misses
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

    private finishTiming(timing: SearchTiming | undefined, start: number, alreadyRecordedForCall: number): number {
        if (!timing) return alreadyRecordedForCall;
        const elapsed = performance.now() - start;
        const delta = Math.max(0, elapsed - alreadyRecordedForCall);
        timing.searchMs = (timing.searchMs ?? 0) + delta;
        timing.totalMs = (timing.totalMs ?? 0) + delta;
        return elapsed;
    }
}
