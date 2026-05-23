import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { ProbabilityMassAccountant, PROJECTION_MASS_BUCKET, PROJECTION_MASS_OPERATION } from '#engine/search/ProbabilityMassAccountant.js';
import { SearchResult, SequentialCheckpointSearchContext, CheckpointSearchContext, EngineInstrumentation, SearchTiming, SearchBackend, RegistryState, MutatedRegistryState } from '#types/index.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { SearchRun, SearchRunSnapshot } from '#lib/search/SearchRun.js';
import type { SearchGraphNodeId } from '#lib/search/SearchGraph.js';
import { GroupedFlexSearchRun, checkFlexReducedKeyInvariant, type GroupedFlexProjectedCheckpoint, type FlexRunSnapshot, type FlexReducedKeyInvariantResult, type FlexStateIdentityMode } from '#lib/search/flex/index.js';
import { FLEX_CACHE_LIMITS, FLEX_INVARIANT_LIMITS } from '#lib/search/flex/FlexConstants.js';
import { SearchStateCache } from '#lib/search/SearchStateCache.js';
import { PRECISION, ProbUtils } from '#utils/index.js';
import { LRUCache } from '#utils/collections/LRUCache.js';
import type { MassAccountingBreakdown, MassAccountingDetailBucket, MassAccountingDetails, MassAccountingOperationDetails, MassAccountingStageDetails } from '#types/mass.js';

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
            const snapshot = await run.searchToCheckpointAsync({
                threshold: request.exhaustive ? 0n : request.threshold ?? 0n,
                maxIterations: request.exhaustive ? undefined : request.maxIterations,
                drainEqualMassBand: request.drainEqualMassBand,
                exhaustive: request.exhaustive,
                targetClassifiedMass: request.exhaustive ? undefined : request.targetClassifiedMass,
                probabilityFloor: request.probabilityFloor,
                signal: request.signal
            });
            const projected = run.projectSnapshot(snapshot);
            this.finishTiming(request.timing, timingStart, 0);
            return this.toFlexSearchResult(projected, snapshot, flexStateIdentityMode, request.exhaustive ? 0n : request.threshold ?? 0n, request.targetClassifiedMass, request.instrumentation, request.timing);
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

            let snapshot: FlexRunSnapshot;
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
            const projected = run.projectSnapshot(snapshot);
            recordedSearchMs = this.finishTiming(request.timing, timingStart, recordedSearchMs);
            lastResult = this.toFlexSearchResult(projected, snapshot, flexStateIdentityMode, checkpoint.threshold, checkpoint.targetClassifiedMass, request.instrumentation, request.timing);
            request.onCheckpointComplete(lastResult, checkpointIndex);
        }

        if (lastResult) return lastResult;

        this.finishTiming(request.timing, timingStart, recordedSearchMs);
        const snapshot = run.snapshot();
        const projected = run.projectSnapshot(snapshot);
        return this.toFlexSearchResult(projected, snapshot, flexStateIdentityMode, 0, undefined, request.instrumentation, request.timing);
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
        projected: GroupedFlexProjectedCheckpoint,
        flexSnapshot: FlexRunSnapshot,
        flexStateIdentityMode: FlexStateIdentityMode,
        threshold: number | bigint | undefined,
        targetClassifiedMass?: number | bigint | undefined,
        instrumentation?: EngineInstrumentation | undefined,
        timing?: SearchTiming | undefined
    ): SearchResult {
        const snapshot = this.toCompatibleFlexSearchRunSnapshot(projected, flexSnapshot);
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
            instrumentation.exitReason = flexSnapshot.exitReason ?? (snapshot.fullyResolved
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
                flexStructuralPendingEntryCount: flexSnapshot.pendingCount,
                flexProjectionLoss: ProbUtils.toNumber(projected.projectionLoss + projected.pendingProjectionLoss),
                flexProjectionClueIncompatible: ProbUtils.toNumber(projected.clueIncompatible + projected.pendingClueIncompatible)
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

    private toCompatibleFlexSearchRunSnapshot(
        projected: GroupedFlexProjectedCheckpoint,
        flexSnapshot: FlexRunSnapshot
    ): SearchRunSnapshot {
        return Object.freeze({
            results: new Map(projected.results),
            mass: this.toCompatibleFlexMass(projected, flexSnapshot),
            iterations: flexSnapshot.iterations,
            lastExpandedMass: flexSnapshot.lastExpandedMass,
            pendingCount: projected.pendingEntries.length,
            largestPendingMass: flexSnapshot.largestPendingMass,
            pendingEntries: Object.freeze(projected.pendingEntries.map(entry => Object.freeze({
                graphId: entry.graphId,
                nodeId: entry.nodeId as unknown as SearchGraphNodeId,
                mass: entry.mass,
                combo: entry.combo,
                count: entry.count
            }))),
            graphCount: flexSnapshot.graphCount,
            seededLevelCount: flexSnapshot.graphCount,
            activeResidueCount: flexSnapshot.activeResidueCount,
            activeResidueMass: flexSnapshot.activeResidueMass,
            fullyResolved: flexSnapshot.fullyResolved,
            suffixMerging: Object.freeze({
                enabled: false,
                canonicalEntryCount: 0,
                hits: 0,
                misses: 0,
                mergedPendingMass: 0n,
                avoidedPendingEntries: 0
            })
        });
    }

    private toCompatibleFlexMass(
        projected: GroupedFlexProjectedCheckpoint,
        flexSnapshot: FlexRunSnapshot
    ): MassAccountingBreakdown {
        const engine = flexSnapshot.mass.units;
        if (!engine) {
            throw new Error('Cannot expose Flex checkpoint without precise engine accounting units.');
        }

        const resolved = projected.projectedMass;
        const pending = projected.projectedPendingMass;
        const clueIncompatible = BigInt(engine.clueIncompatible) + projected.clueIncompatible + projected.pendingClueIncompatible;
        const sieved = BigInt(engine.sieved);
        const overflow = BigInt(engine.overflow);
        const capped = BigInt(engine.capped);
        const rounding = BigInt(engine.rounding) + projected.projectionLoss + projected.pendingProjectionLoss;
        const recoveredRounding = BigInt(engine.recoveredRounding);
        const recoveredSieved = BigInt(engine.recoveredSieved);

        const details = this.toCompatibleFlexMassDetails(projected, flexSnapshot);
        const mass: MassAccountingBreakdown = {
            resolved: ProbUtils.toNumber(resolved),
            clueIncompatible: ProbUtils.toNumber(clueIncompatible),
            pending: ProbUtils.toNumber(pending),
            sieved: ProbUtils.toNumber(sieved),
            overflow: ProbUtils.toNumber(overflow),
            capped: ProbUtils.toNumber(capped),
            rounding: ProbUtils.toNumber(rounding),
            recoveredRounding: ProbUtils.toNumber(recoveredRounding),
            recoveredSieved: ProbUtils.toNumber(recoveredSieved),
            units: Object.freeze({
                resolved: resolved.toString(),
                clueIncompatible: clueIncompatible.toString(),
                pending: pending.toString(),
                sieved: sieved.toString(),
                overflow: overflow.toString(),
                capped: capped.toString(),
                rounding: rounding.toString(),
                recoveredRounding: recoveredRounding.toString(),
                recoveredSieved: recoveredSieved.toString()
            })
        };
        if (details) mass.details = details;
        return Object.freeze(mass);
    }

    private toCompatibleFlexMassDetails(
        projected: GroupedFlexProjectedCheckpoint,
        flexSnapshot: FlexRunSnapshot
    ): MassAccountingDetails | undefined {
        const details = cloneMassAccountingDetails(flexSnapshot.massDetails);
        mergeMassAccountingDetails(details, createFlexProjectionMassDetails(projected));
        if (Object.keys(details.stages).length === 0) return undefined;
        return freezeMassAccountingDetails(details);
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

function cloneMassAccountingDetails(source: MassAccountingDetails | undefined): MassAccountingDetails {
    const stages: Record<string, MassAccountingStageDetails> = {};
    if (!source) return { stages };

    for (const [stageName, stage] of Object.entries(source.stages)) {
        const operations: Record<string, MassAccountingOperationDetails> = {};
        for (const [operationName, operation] of Object.entries(stage.operations)) {
            operations[operationName] = {
                buckets: cloneMassDetailBuckets(operation.buckets)
            };
        }

        stages[stageName] = {
            buckets: cloneMassDetailBuckets(stage.buckets),
            operations
        };
    }

    return { stages };
}

function cloneMassDetailBuckets(
    buckets: Record<string, MassAccountingDetailBucket>
): Record<string, MassAccountingDetailBucket> {
    const clone: Record<string, MassAccountingDetailBucket> = {};
    for (const [bucketName, bucket] of Object.entries(buckets)) {
        clone[bucketName] = { ...bucket };
    }
    return clone;
}

function createFlexProjectionMassDetails(projected: GroupedFlexProjectedCheckpoint): MassAccountingDetails | undefined {
    const accountant = new ProbabilityMassAccountant();
    const results = accountant.forProjectionOperation(PROJECTION_MASS_OPERATION.Results);
    results.record(PROJECTION_MASS_BUCKET.Source, projected.sourceMass);
    results.record(PROJECTION_MASS_BUCKET.Projected, projected.projectedMass);
    results.record(PROJECTION_MASS_BUCKET.ClueIncompatible, projected.clueIncompatible);
    results.record(PROJECTION_MASS_BUCKET.Loss, projected.projectionLoss);

    const pending = accountant.forProjectionOperation(PROJECTION_MASS_OPERATION.Pending);
    pending.record(PROJECTION_MASS_BUCKET.Source, projected.projectedPendingSourceMass);
    pending.record(PROJECTION_MASS_BUCKET.Projected, projected.projectedPendingMass);
    pending.record(PROJECTION_MASS_BUCKET.ClueIncompatible, projected.pendingClueIncompatible);
    pending.record(PROJECTION_MASS_BUCKET.Loss, projected.pendingProjectionLoss);

    return accountant.toPublicDetails();
}

function mergeMassAccountingDetails(target: MassAccountingDetails, source: MassAccountingDetails | undefined): void {
    if (!source) return;

    for (const [stageName, sourceStage] of Object.entries(source.stages)) {
        const targetStage = target.stages[stageName] ?? {
            buckets: {},
            operations: {}
        };
        target.stages[stageName] = targetStage;
        mergeMassDetailBuckets(targetStage.buckets, sourceStage.buckets);

        for (const [operationName, sourceOperation] of Object.entries(sourceStage.operations)) {
            const targetOperation = targetStage.operations[operationName] ?? {
                buckets: {}
            };
            targetStage.operations[operationName] = targetOperation;
            mergeMassDetailBuckets(targetOperation.buckets, sourceOperation.buckets);
        }
    }
}

function mergeMassDetailBuckets(
    target: Record<string, MassAccountingDetailBucket>,
    source: Record<string, MassAccountingDetailBucket>
): void {
    for (const [bucketName, bucket] of Object.entries(source)) {
        addMassDetailBucket(target, bucketName, BigInt(bucket.units));
    }
}

function addMassDetailBucket(
    buckets: Record<string, MassAccountingDetailBucket>,
    bucketName: string,
    units: bigint
): void {
    const previousUnits = BigInt(buckets[bucketName]?.units ?? 0);
    buckets[bucketName] = toMassDetailBucket(previousUnits + units);
}

function toMassDetailBucket(units: bigint): MassAccountingDetailBucket {
    return {
        value: ProbUtils.toNumber(units),
        units: units.toString()
    };
}

function freezeMassAccountingDetails(details: MassAccountingDetails): MassAccountingDetails {
    for (const stage of Object.values(details.stages)) {
        for (const bucket of Object.values(stage.buckets)) Object.freeze(bucket);
        Object.freeze(stage.buckets);

        for (const operation of Object.values(stage.operations)) {
            for (const bucket of Object.values(operation.buckets)) Object.freeze(bucket);
            Object.freeze(operation.buckets);
            Object.freeze(operation);
        }

        Object.freeze(stage.operations);
        Object.freeze(stage);
    }

    return Object.freeze({
        stages: Object.freeze(details.stages)
    });
}
