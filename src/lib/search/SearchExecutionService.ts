import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchResult, SequentialCheckpointSearchContext, CheckpointSearchContext, EngineInstrumentation, SearchTiming, SearchBackend, RegistryState, MutatedRegistryState } from '#types/index.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { SearchRun, SearchRunSnapshot } from '#lib/search/SearchRun.js';
import { PlexRun, ProjectedPlexCheckpoint } from '#lib/search/plex/PlexRun.js';
import { checkPlexReducedKeyInvariant, type PlexReducedKeyInvariantResult } from '#lib/search/plex/PlexReducedKeyInvariant.js';
import { SearchStateCache } from '#lib/search/SearchStateCache.js';
import { PRECISION, ProbUtils } from '#utils/index.js';
import type { MassAccountingBreakdown } from '#types/mass.js';

/**
 * Engine-facing service that advances shared search runs to checkpoint boundaries.
 *
 * It owns run lookup/resume, checkpoint sequencing, instrumentation, and timing.
 * Lower-level `SearchRun` owns probability flow; higher-level services own public
 * summary and UI projection.
 */
export class SearchExecutionService {
    private readonly plexRunCache = new Map<string, PlexRun>();
    private readonly plexReducedKeyInvariantCache = new Map<string, PlexReducedKeyInvariantResult>();
    private plexRunCacheHits = 0;
    private plexRunCacheMisses = 0;

    public constructor(
        private readonly distributionService: ModifiedLevelDistributionService = new ModifiedLevelDistributionService(),
        private readonly cache: SearchStateCache = new SearchStateCache()
    ) {}

    /** Clears all cached structural graphs and resumable runs owned by this service. */
    public clearCache(): void {
        this.cache.clearAll();
        this.plexRunCache.clear();
        this.plexReducedKeyInvariantCache.clear();
        this.plexRunCacheHits = 0;
        this.plexRunCacheMisses = 0;
    }

    /** Advances one request to its next checkpoint or final stop condition. */
    public async searchToCheckpoint(request: CheckpointSearchContext): Promise<SearchResult> {
        const timingStart = request.timing ? performance.now() : 0;
        if (this.getBackend(request) === 'plex') {
            this.throwIfAborted(request.signal);
            const run = this.getPlexRun(request);
            const snapshot = await run.searchToCheckpointAsync({
                threshold: request.exhaustive ? 0n : request.threshold ?? 0n,
                maxIterations: request.exhaustive ? undefined : request.maxIterations,
                exhaustive: request.exhaustive,
                targetClassifiedMass: request.exhaustive ? undefined : request.targetClassifiedMass,
                signal: request.signal
            });
            const projected = run.projectCheckpoint(snapshot);
            this.finishTiming(request.timing, timingStart, 0);
            return this.toPlexSearchResult(projected, request.exhaustive ? 0n : request.threshold ?? 0n, request.targetClassifiedMass, request.instrumentation, request.timing);
        }

        const run = this.getRun(request);
        const snapshot = await run.searchToCheckpointAsync({
            threshold: request.exhaustive ? 0n : request.threshold ?? 0n,
            maxIterations: request.exhaustive ? undefined : request.maxIterations,
            exhaustive: request.exhaustive,
            targetClassifiedMass: request.exhaustive ? undefined : request.targetClassifiedMass,
            signal: request.signal
        });

        this.finishTiming(request.timing, timingStart, 0);
        return this.toSearchResult(snapshot, request.exhaustive ? 0n : request.threshold ?? 0n, request.targetClassifiedMass, request.instrumentation, request.timing);
    }

    /** Advances one run through an ordered checkpoint plan, streaming each completed boundary. */
    public async searchSequentialCheckpoints(request: SequentialCheckpointSearchContext): Promise<SearchResult> {
        const timingStart = request.timing ? performance.now() : 0;
        let recordedSearchMs = 0;
        if (this.getBackend(request) === 'plex') {
            return this.searchSequentialPlexCheckpoints(request, timingStart);
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

        this.finishTiming(request.timing, timingStart, recordedSearchMs);
        const emptySnapshot = run.snapshot();
        return this.toSearchResult(emptySnapshot, 0, undefined, request.instrumentation, request.timing);
    }

    private async searchSequentialPlexCheckpoints(request: SequentialCheckpointSearchContext, timingStart: number): Promise<SearchResult> {
        let recordedSearchMs = 0;
        this.throwIfAborted(request.signal);
        const run = this.getPlexRun(request);
        let lastResult: SearchResult | undefined;

        for (let checkpointIndex = 0; checkpointIndex < request.checkpoints.length; checkpointIndex++) {
            if (request.signal?.aborted) break;

            const checkpoint = request.checkpoints[checkpointIndex];
            if (!checkpoint) continue;

            let snapshot;
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
            const projected = run.projectCheckpoint(snapshot);
            recordedSearchMs = this.finishTiming(request.timing, timingStart, recordedSearchMs);
            lastResult = this.toPlexSearchResult(projected, checkpoint.threshold, checkpoint.targetClassifiedMass, request.instrumentation, request.timing);
            request.onCheckpointComplete(lastResult, checkpointIndex);
        }

        if (lastResult) return lastResult;

        this.finishTiming(request.timing, timingStart, recordedSearchMs);
        const projected = run.projectCheckpoint(run.snapshot());
        return this.toPlexSearchResult(projected, 0, undefined, request.instrumentation, request.timing);
    }

    private getBackend(request: CheckpointSearchContext): SearchBackend {
        return request.searchBackend ?? 'concrete';
    }

    private getRun(request: CheckpointSearchContext): SearchRun {
        const create = () => this.createRun(request);
        if (request.useCache === false) return create();
        return this.cache.getOrCreateRun(this.createRunCacheKey(request), create);
    }

    private getPlexRun(request: CheckpointSearchContext): PlexRun {
        this.assertPlexReducedKeyInvariant(request);
        const create = () => this.createPlexRun(request);
        if (request.useCache === false) return create();

        const key = this.createRunCacheKey(request);
        const cached = this.plexRunCache.get(key);
        if (cached) {
            this.plexRunCacheHits++;
            return cached;
        }

        this.plexRunCacheMisses++;
        const run = create();
        this.plexRunCache.set(key, run);
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

    private createPlexRun(request: CheckpointSearchContext): PlexRun {
        const run = new PlexRun(this.createKernel(request), {
            distributionService: this.distributionService,
            targetClueId: request.targetClueId
        });
        run.seedXp(request.xp);
        return run;
    }

    private assertPlexReducedKeyInvariant(request: CheckpointSearchContext): void {
        if (!isMutatedRegistry(request.registry)) return;

        const key = this.createPlexInvariantCacheKey(request);
        let result = this.plexReducedKeyInvariantCache.get(key);
        if (!result) {
            result = checkPlexReducedKeyInvariant({
                kernel: this.createKernel(request),
                xp: request.xp,
                distributionService: this.distributionService,
                maxConflicts: 1
            });
            this.plexReducedKeyInvariantCache.set(key, result);
        }

        if (result.ok) return;

        const conflict = result.conflicts[0];
        const state = conflict ? `${conflict.graphId}:${String(conflict.nodeId)}` : 'unknown';
        throw new Error(
            `Plex backend cannot run this mutated registry because multiple payload histories reach structural state ${state}. Use the concrete backend.`
        );
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
            targetClueId: request.targetClueId ?? null,
            backend: this.getBackend(request)
        });
    }

    private createPlexInvariantCacheKey(request: CheckpointSearchContext): string {
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

    private toPlexSearchResult(
        projected: ProjectedPlexCheckpoint,
        threshold: number | bigint | undefined,
        targetClassifiedMass?: number | bigint | undefined,
        instrumentation?: EngineInstrumentation | undefined,
        timing?: SearchTiming | undefined
    ): SearchResult {
        const snapshot = this.toCompatibleSearchRunSnapshot(projected);
        const thresholdUnits = ProbUtils.toBigInt(threshold ?? 0);
        const targetClassifiedMassUnits = targetClassifiedMass === undefined
            ? undefined
            : ProbUtils.toBigInt(targetClassifiedMass);
        const pendingUnits = BigInt(snapshot.mass.units?.pending ?? 0);
        const classifiedMassUnits = PRECISION - pendingUnits;
        const projectionUnits = projected.mass.projection?.units;

        if (instrumentation) {
            instrumentation.totalIterations = snapshot.iterations;
            instrumentation.totalPrunedNodes = 0;
            instrumentation.roundingErrorEvents = snapshot.mass.rounding > 0 ? 1 : 0;
            instrumentation.levelsProcessed = snapshot.seededLevelCount;
            instrumentation.levelsFullyResolved = snapshot.fullyResolved ? snapshot.seededLevelCount : 0;
            instrumentation.fullyResolved = snapshot.fullyResolved;
            instrumentation.resultsSize = snapshot.results.size;
            instrumentation.queueSize = snapshot.pendingCount;
            instrumentation.exitReason = projected.exitReason ?? (snapshot.fullyResolved
                ? 'empty'
                : targetClassifiedMassUnits !== undefined && classifiedMassUnits >= targetClassifiedMassUnits
                    ? 'mass'
                    : snapshot.largestPendingMass < thresholdUnits ? 'threshold' : 'iterations');
            instrumentation.poolCache = instrumentation.poolCache ?? { hits: 0, misses: 0 };
            instrumentation.distCache = instrumentation.distCache ?? { hits: 0, misses: 0 };
            instrumentation.search = {
                backend: 'plex',
                graphCount: snapshot.graphCount,
                seededLevelCount: snapshot.seededLevelCount,
                pendingEntryCount: snapshot.pendingCount,
                largestPendingMass: ProbUtils.toNumber(snapshot.largestPendingMass),
                lastExpandedMass: ProbUtils.toNumber(snapshot.lastExpandedMass),
                activeResidueCount: snapshot.activeResidueCount,
                activeResidueMass: ProbUtils.toNumber(snapshot.activeResidueMass),
                canImprove: !snapshot.fullyResolved && snapshot.largestPendingMass >= thresholdUnits,
                graphCacheHits: 0,
                graphCacheMisses: 0,
                runCacheHits: this.plexRunCacheHits,
                runCacheMisses: this.plexRunCacheMisses,
                suffixMergingEnabled: false,
                suffixMergeCanonicalEntryCount: 0,
                suffixMergeHits: 0,
                suffixMergeMisses: 0,
                suffixMergedPendingMass: 0,
                suffixAvoidedPendingEntries: 0,
                plexStructuralPendingEntryCount: projected.pendingCount,
                plexProjectionLoss: projectionUnits ? ProbUtils.toNumber(BigInt(projectionUnits.loss)) : undefined,
                plexProjectionClueIncompatible: projectionUnits ? ProbUtils.toNumber(BigInt(projectionUnits.clueIncompatible)) : undefined
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

    private toCompatibleSearchRunSnapshot(projected: ProjectedPlexCheckpoint): SearchRunSnapshot {
        return Object.freeze({
            results: new Map(projected.results),
            mass: this.toCompatibleMass(projected),
            iterations: projected.iterations,
            lastExpandedMass: projected.lastExpandedMass,
            pendingCount: projected.pendingEntries.length,
            largestPendingMass: projected.largestPendingMass,
            pendingEntries: projected.pendingEntries,
            graphCount: projected.graphCount,
            seededLevelCount: projected.seededLevelCount,
            activeResidueCount: projected.activeResidueCount,
            activeResidueMass: projected.activeResidueMass,
            fullyResolved: projected.fullyResolved,
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

    private toCompatibleMass(projected: ProjectedPlexCheckpoint): MassAccountingBreakdown {
        const engine = projected.mass.engine.units;
        const projection = projected.mass.projection?.units;
        if (!engine || !projection) {
            throw new Error('Cannot expose Plex checkpoint without precise engine and projection accounting units.');
        }

        const resolved = projected.projectedResultMass;
        const pending = projected.projectedPendingMass;
        const clueIncompatible = BigInt(engine.clueIncompatible) + BigInt(projection.clueIncompatible);
        const sieved = BigInt(engine.sieved);
        const overflow = BigInt(engine.overflow);
        const capped = BigInt(engine.capped);
        // Compatibility snapshots have only engine-era buckets. Preserve conservation by
        // treating concrete-view projection loss as rounding uncertainty at this boundary;
        // Plex-specific diagnostics keep the projection loss visible separately.
        const rounding = BigInt(engine.rounding) + BigInt(projection.loss);
        const recoveredRounding = BigInt(engine.recoveredRounding);
        const recoveredSieved = BigInt(engine.recoveredSieved);

        return Object.freeze({
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
        });
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
