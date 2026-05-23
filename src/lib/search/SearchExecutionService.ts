import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchResult, SequentialCheckpointSearchContext, CheckpointSearchContext, EngineInstrumentation, SearchTiming, SearchBackend, RegistryState, MutatedRegistryState, RESULT_COMBO_MODE, type ResultComboMode } from '#types/index.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { SearchRun, type SearchRunSnapshot } from '#lib/search/SearchRun.js';
import { GroupedFlexSearchRun, checkFlexReducedKeyInvariant, type FlexNativeCheckpoint, type FlexReducedKeyInvariantResult, type FlexRunState, type FlexStateIdentityMode } from '#lib/search/flex/index.js';
import { FLEX_CACHE_LIMITS, FLEX_INVARIANT_LIMITS } from '#lib/search/flex/FlexConstants.js';
import { SearchStateCache } from '#lib/search/SearchStateCache.js';
import { PRECISION, ProbUtils } from '#utils/index.js';
import { LRUCache } from '#utils/collections/LRUCache.js';

/**
 * Engine-facing service that advances shared search runs to checkpoint boundaries.
 *
 * It owns run lookup/resume, checkpoint sequencing, instrumentation, and timing.
 * Lower-level `SearchRun` owns probability flow; higher-level services own public
 * summary and UI projection.
 */
export class SearchExecutionService {
    private readonly flexReducedKeyInvariantCache = new LRUCache<string, FlexReducedKeyInvariantResult>(FLEX_CACHE_LIMITS.REDUCED_KEY_INVARIANTS);
    private readonly flexRunCache = new LRUCache<string, GroupedFlexSearchRun>(FLEX_CACHE_LIMITS.RUNS);
    private flexRunCacheHits = 0;
    private flexRunCacheMisses = 0;

    public constructor(
        private readonly distributionService: ModifiedLevelDistributionService = new ModifiedLevelDistributionService(),
        private readonly cache: SearchStateCache = new SearchStateCache()
    ) {}

    /** Clears all cached structural graphs and resumable runs owned by this service. */
    public clearCache(): void {
        this.cache.clearAll();
        this.flexReducedKeyInvariantCache.clear();
        this.flexRunCache.clear();
        this.flexRunCacheHits = 0;
        this.flexRunCacheMisses = 0;
    }

    /** Advances one request to its next checkpoint or final stop condition. */
    public async searchToCheckpoint(request: CheckpointSearchContext): Promise<SearchResult> {
        const timingStart = request.timing ? performance.now() : 0;
        if (this.getBackend(request) === 'flex') {
            this.throwIfAborted(request.signal);
            const flexStateIdentityMode = this.getFlexStateIdentityMode(request);
            const run = this.getFlexRun(request, flexStateIdentityMode);
            const flexState = await run.searchToCheckpointStateAsync({
                threshold: request.exhaustive ? 0n : request.threshold ?? 0n,
                maxIterations: request.exhaustive ? undefined : request.maxIterations,
                drainEqualMassBand: request.drainEqualMassBand,
                exhaustive: request.exhaustive,
                targetClassifiedMass: request.exhaustive ? undefined : request.targetClassifiedMass,
                probabilityFloor: request.probabilityFloor,
                signal: request.signal
            });
            const checkpoint = run.buildEngineSnapshot(flexState, {
                resultComboMode: this.getResultComboMode(request)
            });
            this.finishTiming(request.timing, timingStart, 0);
            return this.toFlexSearchResult(checkpoint, flexState, flexStateIdentityMode, request.exhaustive ? 0n : request.threshold ?? 0n, request.targetClassifiedMass, request.instrumentation, request.timing);
        }

        const run = this.getRun(request);
        const snapshot = await run.searchToCheckpointAsync({
            threshold: request.exhaustive ? 0n : request.threshold ?? 0n,
            maxIterations: request.exhaustive ? undefined : request.maxIterations,
            drainEqualMassBand: request.drainEqualMassBand,
            exhaustive: request.exhaustive,
            targetClassifiedMass: request.exhaustive ? undefined : request.targetClassifiedMass,
            probabilityFloor: request.probabilityFloor,
            signal: request.signal
        });

        this.finishTiming(request.timing, timingStart, 0);
        return this.toSearchResult(snapshot, request.exhaustive ? 0n : request.threshold ?? 0n, request.targetClassifiedMass, request.instrumentation, request.timing);
    }

    /** Advances one run through an ordered checkpoint plan, streaming each completed boundary. */
    public async searchSequentialCheckpoints(request: SequentialCheckpointSearchContext): Promise<SearchResult> {
        const timingStart = request.timing ? performance.now() : 0;
        let recordedSearchMs = 0;
        if (this.getBackend(request) === 'flex') {
            return this.searchSequentialFlexCheckpoints(request, timingStart);
        }

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
                    drainEqualMassBand: request.drainEqualMassBand,
                    targetClassifiedMass: checkpoint.targetClassifiedMass,
                    probabilityFloor: request.probabilityFloor,
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

        this.finishTiming(request.timing, timingStart, recordedSearchMs);
        const emptySnapshot = run.snapshot();
        return this.toSearchResult(emptySnapshot, 0, undefined, request.instrumentation, request.timing);
    }

    private async searchSequentialFlexCheckpoints(request: SequentialCheckpointSearchContext, timingStart: number): Promise<SearchResult> {
        let recordedSearchMs = 0;
        this.throwIfAborted(request.signal);
        const flexStateIdentityMode = this.getFlexStateIdentityMode(request);
        const run = this.getFlexRun(request, flexStateIdentityMode);
        let lastResult: SearchResult | undefined;

        for (let checkpointIndex = 0; checkpointIndex < request.checkpoints.length; checkpointIndex++) {
            if (request.signal?.aborted) break;

            const checkpoint = request.checkpoints[checkpointIndex];
            if (!checkpoint) continue;

            let flexState: FlexRunState;
            try {
                flexState = await run.searchToCheckpointStateAsync({
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
            const nativeCheckpoint = run.buildEngineSnapshot(flexState, {
                resultComboMode: this.getResultComboMode(request, checkpoint)
            });
            recordedSearchMs = this.finishTiming(request.timing, timingStart, recordedSearchMs);
            lastResult = this.toFlexSearchResult(nativeCheckpoint, flexState, flexStateIdentityMode, checkpoint.threshold, checkpoint.targetClassifiedMass, request.instrumentation, request.timing);
            request.onCheckpointComplete(lastResult, checkpointIndex);
        }

        if (lastResult) return lastResult;

        this.finishTiming(request.timing, timingStart, recordedSearchMs);
        const flexState = run.state();
        const checkpoint = run.buildEngineSnapshot(flexState, {
            resultComboMode: this.getResultComboMode(request)
        });
        return this.toFlexSearchResult(checkpoint, flexState, flexStateIdentityMode, 0, undefined, request.instrumentation, request.timing);
    }

    private getBackend(request: CheckpointSearchContext): SearchBackend {
        const backend = (request as { readonly searchBackend?: string }).searchBackend ?? 'concrete';
        if (backend === 'concrete' || backend === 'flex') return backend;
        throw new Error(`Unsupported search backend "${String(backend)}". Supported backends: "concrete", "flex".`);
    }

    private getRun(request: CheckpointSearchContext): SearchRun {
        const create = () => this.createRun(request);
        if (request.useCache === false) return create();
        return this.cache.getOrCreateRun(this.createRunCacheKey(request), create);
    }

    private getFlexRun(request: CheckpointSearchContext, stateIdentityMode: FlexStateIdentityMode): GroupedFlexSearchRun {
        const create = () => this.createFlexRun(request, stateIdentityMode);
        if (request.useCache === false) return create();

        const key = this.createRunCacheKey(request, stateIdentityMode);
        const cached = this.flexRunCache.get(key);
        if (cached) {
            this.flexRunCacheHits++;
            return cached;
        }

        this.flexRunCacheMisses++;
        const run = create();
        this.flexRunCache.set(key, run);
        return run;
    }

    private createRun(request: CheckpointSearchContext): SearchRun {
        const kernel = this.createKernel(request);
        const run = new SearchRun(kernel, {
            distributionService: this.distributionService,
            targetClueId: request.targetClueId,
            graphCache: this.cache
        });
        run.seedXp(request.xp);
        return run;
    }

    private createFlexRun(request: CheckpointSearchContext, stateIdentityMode: FlexStateIdentityMode): GroupedFlexSearchRun {
        const run = new GroupedFlexSearchRun(this.createKernel(request), {
            distributionService: this.distributionService,
            targetClueId: request.targetClueId,
            stateIdentityMode
        });
        run.seedXp(request.xp);
        return run;
    }

    private getFlexStateIdentityMode(request: CheckpointSearchContext): FlexStateIdentityMode {
        if (!isMutatedRegistry(request.registry)) return 'reduced';

        const key = this.createFlexInvariantCacheKey(request);
        let result = this.flexReducedKeyInvariantCache.get(key);
        if (!result) {
            result = checkFlexReducedKeyInvariant({
                kernel: this.createKernel(request),
                xp: request.xp,
                distributionService: this.distributionService,
                maxConflicts: FLEX_INVARIANT_LIMITS.MIN_CONFLICTS
            });
            this.flexReducedKeyInvariantCache.set(key, result);
        }

        return result.ok ? 'reduced' : 'program';
    }

    private getResultComboMode(
        request: CheckpointSearchContext,
        checkpoint?: { readonly resultComboMode?: ResultComboMode | undefined } | undefined
    ): ResultComboMode {
        return checkpoint?.resultComboMode ?? request.resultComboMode ?? RESULT_COMBO_MODE.EXACT;
    }

    private createKernel(request: CheckpointSearchContext): RegistryKernel {
        return new RegistryKernel({
            registry: request.registry,
            item: request.item,
            material: request.material
        });
    }

    private createRunCacheKey(
        request: CheckpointSearchContext,
        flexStateIdentityMode?: FlexStateIdentityMode
    ): string {
        return JSON.stringify({
            schema: 1,
            version: request.registry.version,
            item: request.item,
            material: request.material,
            xp: request.xp,
            targetClueId: request.targetClueId ?? null,
            backend: this.getBackend(request),
            flexStateIdentityMode: flexStateIdentityMode ?? null
        });
    }

    private createFlexInvariantCacheKey(request: CheckpointSearchContext): string {
        return JSON.stringify({
            schema: 1,
            version: request.registry.version,
            item: request.item,
            material: request.material,
            xp: request.xp,
            mutations: isMutatedRegistry(request.registry) ? request.registry.mutations : null
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
                backend: 'concrete',
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
                runCacheMisses: cacheMetrics.runs.misses,
                suffixMergingEnabled: snapshot.suffixMerging.enabled,
                suffixMergeCanonicalEntryCount: snapshot.suffixMerging.canonicalEntryCount,
                suffixMergeHits: snapshot.suffixMerging.hits,
                suffixMergeMisses: snapshot.suffixMerging.misses,
                suffixMergedPendingMass: ProbUtils.toNumber(snapshot.suffixMerging.mergedPendingMass),
                suffixAvoidedPendingEntries: snapshot.suffixMerging.avoidedPendingEntries
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

    private toFlexSearchResult(
        checkpoint: FlexNativeCheckpoint,
        flexState: FlexRunState,
        flexStateIdentityMode: FlexStateIdentityMode,
        threshold: number | bigint | undefined,
        targetClassifiedMass?: number | bigint | undefined,
        instrumentation?: EngineInstrumentation | undefined,
        timing?: SearchTiming | undefined
    ): SearchResult {
        const snapshot = checkpoint.snapshot;
        const thresholdUnits = ProbUtils.toBigInt(threshold ?? 0);
        const targetClassifiedMassUnits = targetClassifiedMass === undefined
            ? undefined
            : ProbUtils.toBigInt(targetClassifiedMass);
        const pendingUnits = BigInt(snapshot.mass.units?.pending ?? 0);
        const classifiedMassUnits = PRECISION - pendingUnits;

        if (instrumentation) {
            instrumentation.totalIterations = snapshot.iterations;
            instrumentation.totalPrunedNodes = 0;
            instrumentation.roundingErrorEvents = snapshot.mass.rounding > 0 ? 1 : 0;
            instrumentation.levelsProcessed = snapshot.graphCount;
            instrumentation.levelsFullyResolved = snapshot.fullyResolved ? snapshot.graphCount : 0;
            instrumentation.fullyResolved = snapshot.fullyResolved;
            instrumentation.resultsSize = snapshot.results.size;
            instrumentation.queueSize = snapshot.pendingCount;
            instrumentation.exitReason = flexState.exitReason ?? (snapshot.fullyResolved
                ? 'empty'
                : targetClassifiedMassUnits !== undefined && classifiedMassUnits >= targetClassifiedMassUnits
                    ? 'mass'
                    : snapshot.largestPendingMass < thresholdUnits ? 'threshold' : 'iterations');
            instrumentation.poolCache = instrumentation.poolCache ?? { hits: 0, misses: 0 };
            instrumentation.distCache = instrumentation.distCache ?? { hits: 0, misses: 0 };
            instrumentation.search = {
                backend: 'flex',
                graphCount: snapshot.graphCount,
                seededLevelCount: snapshot.graphCount,
                pendingEntryCount: snapshot.pendingCount,
                largestPendingMass: ProbUtils.toNumber(snapshot.largestPendingMass),
                lastExpandedMass: ProbUtils.toNumber(snapshot.lastExpandedMass),
                activeResidueCount: snapshot.activeResidueCount,
                activeResidueMass: ProbUtils.toNumber(snapshot.activeResidueMass),
                canImprove: !snapshot.fullyResolved && snapshot.largestPendingMass >= thresholdUnits,
                graphCacheHits: 0,
                graphCacheMisses: 0,
                runCacheHits: this.flexRunCacheHits,
                runCacheMisses: this.flexRunCacheMisses,
                suffixMergingEnabled: false,
                suffixMergeCanonicalEntryCount: 0,
                suffixMergeHits: 0,
                suffixMergeMisses: 0,
                suffixMergedPendingMass: 0,
                suffixAvoidedPendingEntries: 0,
                flexStateIdentityMode,
                flexStructuralPendingEntryCount: flexState.pendingCount,
                flexProjectionLoss: ProbUtils.toNumber(checkpoint.projectionLoss),
                flexProjectionClueIncompatible: ProbUtils.toNumber(checkpoint.projectionClueIncompatible)
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

function isMutatedRegistry(registry: RegistryState): registry is MutatedRegistryState {
    return 'source' in registry && registry.source === 'mutated';
}
