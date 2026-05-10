import { ENGINE_LIMITS } from '#constants/engine.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchResult, SequentialCheckpointSearchContext, CheckpointSearchContext, EngineInstrumentation, SearchTiming } from '#types/index.js';
import { RegistryKernel } from '#lib/v7/registry/RegistryKernel.js';
import { SearchRun, V7SearchRunSnapshot } from '#lib/v7/search/SearchRun.js';
import { ProbUtils } from '#utils/index.js';

/**
 * V7 adapter for the existing engine boundary.
 *
 * This intentionally returns the existing SearchResult shape so SummaryService,
 * SnapshotService, and workers can be migrated before their public contracts move.
 */
export class V7SearchService {
    public constructor(
        private readonly distributionService: ModifiedLevelDistributionService = new ModifiedLevelDistributionService()
    ) {}

    public async searchToCheckpoint(request: CheckpointSearchContext): Promise<SearchResult> {
        const timingStart = request.timing ? performance.now() : 0;
        let recordedSearchMs = 0;
        const run = this.createRun(request);
        const snapshot = run.searchToCheckpoint({
            threshold: request.threshold ?? ENGINE_LIMITS.DEFAULT_THRESHOLD,
            maxIterations: request.maxIterations ?? ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED
        });

        recordedSearchMs = this.finishTiming(request.timing, timingStart, recordedSearchMs);
        return this.toSearchResult(snapshot, request.threshold, request.instrumentation, request.timing);
    }

    public async searchSequentialCheckpoints(request: SequentialCheckpointSearchContext): Promise<SearchResult> {
        const timingStart = request.timing ? performance.now() : 0;
        let recordedSearchMs = 0;
        const run = this.createRun(request);
        let lastResult: SearchResult | undefined;

        for (let checkpointIndex = 0; checkpointIndex < request.checkpoints.length; checkpointIndex++) {
            if (request.signal?.aborted) break;

            const checkpoint = request.checkpoints[checkpointIndex];
            if (!checkpoint) continue;

            const snapshot = run.searchToCheckpoint({
                threshold: checkpoint.threshold,
                maxIterations: checkpoint.limit
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

    private createRun(request: CheckpointSearchContext): SearchRun {
        const kernel = new RegistryKernel({
            registry: request.registry,
            item: request.item,
            material: request.material
        });
        const run = new SearchRun(kernel, {
            distributionService: this.distributionService,
            targetClueId: request.targetClueId
        });
        run.seedXp(request.xp);
        return run;
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

        if (instrumentation) {
            instrumentation.totalIterations = snapshot.iterations;
            instrumentation.totalPrunedNodes = 0;
            instrumentation.roundingErrorEvents = snapshot.mass.rounding > 0 ? 1 : 0;
            instrumentation.levelsProcessed = snapshot.seededLevelCount;
            instrumentation.levelsFullyResolved = snapshot.fullyResolved ? snapshot.seededLevelCount : 0;
            instrumentation.fullyResolved = snapshot.fullyResolved;
            instrumentation.resultsSize = snapshot.results.size;
            instrumentation.queueSize = snapshot.pendingCount;
            instrumentation.indexMapSize = snapshot.pendingCount;
            instrumentation.exitReason = snapshot.fullyResolved ? 'empty' : 'threshold';
            instrumentation.poolCache = instrumentation.poolCache ?? { hits: 0, misses: 0 };
            instrumentation.distCache = instrumentation.distCache ?? { hits: 0, misses: 0 };
            instrumentation.frontierCache = instrumentation.frontierCache ?? { hits: 0, misses: 0 };
        }

        return {
            combos: new Map(snapshot.results),
            tracker,
            frontiers: [],
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
