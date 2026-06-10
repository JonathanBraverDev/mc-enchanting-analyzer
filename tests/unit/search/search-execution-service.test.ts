import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/index.js';
import { RegistryFactory } from '#core/factory.js';
import { getEligibleMaterials } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { DATA } from '#data/index.js';
import { getDefaultStatsCheckpoint, getSearchCheckpointForRefinement } from '#core/config.js';
import { getRegistryVersionBoundaries } from '#core/version-resolution.js';
import { SearchExecutionService } from '#lib/search/SearchExecutionService.js';
import { ENGINE_FRONTIER_KIND } from '#lib/search/SearchSnapshot.js';
import { FLEX_RUN_CACHE_LIMITS } from '#lib/search/flex/FlexConstants.js';
import { CheckpointSearchRequest, EnchantStats, EngineInstrumentation, SearchResult } from '#types/index.js';
import { PRECISION } from '#utils/index.js';

const ACCOUNTING_UNIT_BUCKETS = [
    'resolved',
    'clueIncompatible',
    'pending',
    'sieved',
    'overflow',
    'capped',
    'rounding',
    'recoveredRounding',
    'recoveredSieved'
] as const;

type AccountingUnitBucket = typeof ACCOUNTING_UNIT_BUCKETS[number];
type AccountingUnitBreakdown = Record<AccountingUnitBucket, bigint>;

function accountingTotal(stats: EnchantStats): number {
    const a = stats.accounting;
    return a.resolved + a.clueIncompatible + a.pending + a.sieved + a.overflow + a.capped + a.rounding;
}

function snapshotAccountingTotal(result: SearchResult): number {
    const a = result.snapshot.mass;
    return a.resolved + a.clueIncompatible + a.pending + a.sieved + a.overflow + a.capped + a.rounding;
}

function getStageDetailUnits(result: SearchResult, stage: string, bucket: string): bigint {
    return BigInt(result.snapshot.mass.details?.stages[stage]?.buckets[bucket]?.units ?? 0);
}

function getOperationDetailUnits(result: SearchResult, stage: string, operation: string, bucket: string): bigint {
    return BigInt(result.snapshot.mass.details?.stages[stage]?.operations[operation]?.buckets[bucket]?.units ?? 0);
}

function getPublicAccountingUnits(result: SearchResult, label: string): AccountingUnitBreakdown {
    const units = result.snapshot.mass.units;
    assert.ok(units, `${label}: missing precise mass accounting units`);

    const output = {} as AccountingUnitBreakdown;
    for (const bucket of ACCOUNTING_UNIT_BUCKETS) output[bucket] = BigInt(units[bucket]);
    return output;
}

function foldSearchDetailUnits(result: SearchResult, label: string): AccountingUnitBreakdown {
    assert.ok(result.snapshot.mass.details, `${label}: missing detailed mass accounting`);

    assert.strictEqual(
        getStageDetailUnits(result, 'search', 'resolved'),
        getOperationDetailUnits(result, 'projection', 'results', 'source'),
        `${label}: result projection source should equal search resolved mass`
    );
    assert.strictEqual(
        getStageDetailUnits(result, 'search', 'pending'),
        getOperationDetailUnits(result, 'projection', 'pending', 'source'),
        `${label}: pending projection source should equal search pending mass`
    );

    return {
        resolved: getOperationDetailUnits(result, 'projection', 'results', 'projected'),
        clueIncompatible: getStageDetailUnits(result, 'search', 'clueIncompatible')
            + getStageDetailUnits(result, 'projection', 'clueIncompatible'),
        pending: getOperationDetailUnits(result, 'projection', 'pending', 'projected'),
        sieved: getStageDetailUnits(result, 'search', 'sieved'),
        overflow: getStageDetailUnits(result, 'search', 'overflow'),
        capped: getStageDetailUnits(result, 'search', 'capped'),
        rounding: getStageDetailUnits(result, 'search', 'rounding')
            + getStageDetailUnits(result, 'projection', 'loss'),
        recoveredRounding: getStageDetailUnits(result, 'search', 'recoveredRounding'),
        recoveredSieved: getStageDetailUnits(result, 'search', 'recoveredSieved')
    };
}

function assertAccountingUnitsEqual(label: string, actual: AccountingUnitBreakdown, expected: AccountingUnitBreakdown): void {
    for (const bucket of ACCOUNTING_UNIT_BUCKETS) {
        assert.strictEqual(actual[bucket], expected[bucket], `${label}: ${bucket}`);
    }
}

function assertPublicStatsMatch(label: string, expected: EnchantStats, candidate: EnchantStats): void {
    assert.strictEqual(candidate.threshold, expected.threshold, `${label}: threshold`);
    assert.strictEqual(candidate.accuracy, expected.accuracy, `${label}: accuracy`);
    assert.deepStrictEqual(candidate.combos, expected.combos, `${label}: combos`);
    assert.deepStrictEqual(candidate.any, expected.any, `${label}: any`);
    assert.deepStrictEqual(candidate.ranks, expected.ranks, `${label}: ranks`);
    assert.deepStrictEqual(candidate.count, expected.count, `${label}: count`);
    const accountingBuckets = ['resolved', 'clueIncompatible', 'pending', 'sieved', 'overflow', 'capped', 'rounding'] as const;
    for (const bucket of accountingBuckets) {
        assert.ok(
            Math.abs(candidate.accounting[bucket] - expected.accounting[bucket]) <= 1e-12,
            `${label}: accounting.${bucket}`
        );
    }
}

function createInstrumentation(): EngineInstrumentation {
    return {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        totalIterations: 0,
        totalPrunedNodes: 0,
        roundingErrorEvents: 0,
        levelsProcessed: 0,
        levelsFullyResolved: 0,
        fullyResolved: false
    };
}

interface CacheFillCase {
    readonly registry: ReturnType<typeof RegistryFactory.build>;
    readonly item: string;
    readonly material: string;
    readonly xp: number;
}

interface SearchExecutionServiceInternals {
    readonly flexSearchRunCache: { readonly size: number };
}

describe('Search execution service', () => {
    it('uses the merged factorized runtime as the default execution path', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const instrumentation = createInstrumentation();

        const result = await engine.searchToCheckpoint({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0,
            maxIterations: 1,
            instrumentation
        });

        assert.strictEqual(result.snapshot.pendingEntries.length, 0);
        assert.strictEqual(result.snapshot.frontier.kind, ENGINE_FRONTIER_KIND.FACTORIZED);
        assert.ok(result.snapshot.pendingAggregates);
    });

    it('records merge diagnostics for checkpoint searches', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const instrumentation = createInstrumentation();

        const result = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 1,
            instrumentation
        });

        assert.strictEqual(result.instrumentation?.exitReason, 'iterations');
        assert.strictEqual(result.snapshot.frontier.kind, ENGINE_FRONTIER_KIND.FACTORIZED);
        if (result.snapshot.frontier.kind !== ENGINE_FRONTIER_KIND.FACTORIZED) {
            throw new Error('Expected factorized frontier');
        }
        assert.strictEqual(result.snapshot.pendingEntries.length, 0);
        assert.ok(result.snapshot.pendingAggregates);
        assert.strictEqual(result.snapshot.frontier.summary, result.snapshot.pendingAggregates);
        assert.ok(result.snapshot.pendingAggregates.count.reduce((sum, mass) => sum + mass, 0n) > 0n);
        const search = result.instrumentation?.search;
        assert.ok(search);
        assert.strictEqual(search.pendingEntryCount, result.snapshot.pendingCount);
        assert.ok((search.exactPoolCount ?? 0) > 0);
        assert.ok((search.sharedGraphCount ?? 0) > 0);
        assert.ok((search.mergedPoolCount ?? 0) > 0);
        assert.ok((search.sharedGraphCount ?? 0) < (search.exactPoolCount ?? 0));
        assert.ok(Math.abs(snapshotAccountingTotal(result) - 1) < 1e-12);
    });

    it('keeps clue-conditioned checkpoints on the native factorized frontier', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');

        const result = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            clue: 'Sharpness III',
            threshold: 0,
            maxIterations: 1,
        });

        assert.strictEqual(result.snapshot.frontier.kind, ENGINE_FRONTIER_KIND.FACTORIZED);
        if (result.snapshot.frontier.kind !== ENGINE_FRONTIER_KIND.FACTORIZED) {
            throw new Error('Expected factorized Flex frontier');
        }
        assert.strictEqual(result.snapshot.pendingEntries.length, 0);
        assert.ok(result.snapshot.frontier.summary.clueJoint);
        assert.strictEqual(
            result.snapshot.frontier.summary.shownClueDistribution.get(result.snapshot.frontier.summary.clueJoint.targetClueId),
            result.snapshot.frontier.summary.clueJoint.knownSpace
        );
    });

    it('exposes Flex rank-merge mass accounting details without changing compatible public totals', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');

        const result = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 1,
        });

        assert.ok(result.snapshot.mass.details);
        assert.ok(getOperationDetailUnits(result, 'search', 'seed', 'pending') > 0n);
        assert.ok(getOperationDetailUnits(result, 'search', 'frontier', 'pending') < 0n);
        assert.ok(getOperationDetailUnits(result, 'projection', 'pending', 'source') > 0n);
        assert.ok(getOperationDetailUnits(result, 'projection', 'pending', 'projected') > 0n);

        const searchTotal = getStageDetailUnits(result, 'search', 'resolved')
            + getStageDetailUnits(result, 'search', 'clueIncompatible')
            + getStageDetailUnits(result, 'search', 'pending')
            + getStageDetailUnits(result, 'search', 'sieved')
            + getStageDetailUnits(result, 'search', 'overflow')
            + getStageDetailUnits(result, 'search', 'capped')
            + getStageDetailUnits(result, 'search', 'rounding');
        assert.strictEqual(searchTotal, PRECISION);

        const projectionSource = getStageDetailUnits(result, 'projection', 'source');
        const projectionOutput = getStageDetailUnits(result, 'projection', 'projected')
            + getStageDetailUnits(result, 'projection', 'clueIncompatible')
            + getStageDetailUnits(result, 'projection', 'loss');
        assert.strictEqual(projectionSource, projectionOutput);
        assert.ok(Math.abs(snapshotAccountingTotal(result) - 1) < 1e-12);
    });

    it('folds detailed Flex rank-merge mass accounting back to public buckets', async () => {
        const cases: Array<{ readonly label: string; readonly request: CheckpointSearchRequest }> = [
            {
                label: 'bounded book checkpoint',
                request: {
                    item: 'book',
                    material: 'book',
                    xp: 30,
                    threshold: 0,
                    maxIterations: 1,
                    probabilityFloor: 0n
                }
            },
            {
                label: 'exhaustive low-XP mace',
                request: {
                    item: 'mace',
                    material: 'mace',
                    xp: 1,
                    exhaustive: true
                }
            },
            {
                label: 'bounded exact clue checkpoint',
                request: {
                    item: 'sword',
                    material: 'diamond',
                    xp: 30,
                    clue: 'Sharpness III',
                    threshold: 0,
                    maxIterations: 10_000,
                    probabilityFloor: 0n
                }
            }
        ];

        for (const testCase of cases) {
            const result = await EngineFactory.createForVersion('1.21.11').searchToCheckpoint({
                ...testCase.request,
                useCache: false
            });

            const publicAccounting = getPublicAccountingUnits(result, testCase.label);
            assertAccountingUnitsEqual(
                `${testCase.label}: folded search details`,
                foldSearchDetailUnits(result, testCase.label),
                publicAccounting
            );
        }
    });

    it('resumes cached Flex rank-merge runs across one-at-a-time checkpoint calls', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const first = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 50,
            instrumentation: createInstrumentation()
        });
        const resumed = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 10,
            instrumentation: createInstrumentation()
        });

        assert.strictEqual(first.instrumentation?.totalIterations, 50);
        assert.strictEqual(resumed.instrumentation?.totalIterations, 50);
        assert.ok((resumed.instrumentation?.search?.runCacheHits ?? 0) >= 1);
    });

    it('keeps the Flex rank-merge run cache bounded', async () => {
        const service = new SearchExecutionService();
        const cases = createCacheFillCases(FLEX_RUN_CACHE_LIMITS.RUNS + 12);

        assert.ok(cases.length > FLEX_RUN_CACHE_LIMITS.RUNS, 'fixture should exceed the Flex rank-merge run cache capacity');
        for (const testCase of cases) {
            await service.searchToCheckpoint({
                registry: testCase.registry,
                item: testCase.item,
                material: testCase.material,
                xp: testCase.xp,
                threshold: 0,
                maxIterations: 1,
            });
        }

        assert.ok(
            getFlexSearchRunCacheSize(service) <= FLEX_RUN_CACHE_LIMITS.RUNS,
            'Flex search run cache should evict old runs instead of growing without bound'
        );
    });

    it('supports Flex rank-merge through the public stats API while preserving compatible accounting', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const stats = await engine.getStats({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0,
            maxIterations: 250,
            summaryLimit: 10,
            instrumentation: createInstrumentation()
        });

        assert.ok(Object.keys(stats.combos).length > 0);
        assert.ok(stats.accounting.pending > 0);
        assert.ok(Math.abs(accountingTotal(stats) - 1) < 1e-12);
    });

    it('matches explicit Flex rank-merge stats to the default public API for a fully resolved case', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const [defaults, explicit] = await Promise.all([
            engine.getStats({
                item: 'mace',
                material: 'mace',
                xp: 1,
                exhaustive: true,
                summaryLimit: 100,
                useCache: false
            }),
            engine.getStats({
                item: 'mace',
                material: 'mace',
                xp: 1,
                exhaustive: true,
                summaryLimit: 100,
                instrumentation: createInstrumentation(),
                useCache: false
            })
        ]);

        assertPublicStatsMatch('Flex rank-merge public stats', defaults, explicit);
    });

    it('supports Flex rank-merge for mutated registries with dense conflict graphs', async () => {
        const registry = RegistryFactory.buildWithMutations('1.21.11', [
            { type: 'addConflictRule', rule: { enchants: ['Smite', 'Looting'], valid_from: '1.0' } },
            { type: 'addConflictRule', rule: { enchants: ['Looting', 'Unbreaking'], valid_from: '1.0' } },
            { type: 'addConflictRule', rule: { enchants: ['Unbreaking', 'Sharpness'], valid_from: '1.0' } }
        ]);
        const engine = EngineFactory.create(registry);
        const instrumentation = createInstrumentation();

        const result = await engine.searchToCheckpoint({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0,
            maxIterations: 100,
            instrumentation
        });

        assert.ok((result.instrumentation?.search?.exactPoolCount ?? 0) > 0);
        assert.ok(result.snapshot.mass.resolved + result.snapshot.mass.pending > 0);
    });

    it('supports Flex rank-merge for mutated registries with looser conflict graphs', async () => {
        const registry = RegistryFactory.buildWithMutations('1.21.11', {
            type: 'removeConflictRule',
            selector: { enchants: ['Smite', 'Sharpness'], valid_from: '1.0' }
        });
        const engine = EngineFactory.create(registry);
        const instrumentation = createInstrumentation();

        const result = await engine.searchToCheckpoint({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0,
            maxIterations: 100,
            instrumentation
        });

        assert.ok((result.instrumentation?.search?.exactPoolCount ?? 0) > 0);
        assert.ok(result.snapshot.mass.resolved + result.snapshot.mass.pending > 0);
    });

    it('produces EnchantStats through the public stats API', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const stats = await engine.getStats({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0n,
            maxIterations: 250,
            summaryLimit: 10,
        });

        assert.ok(Object.keys(stats.combos).length > 0);
        assert.ok(stats.accuracy > 0);
        assert.ok(stats.accounting.pending > 0);
        assert.ok(Math.abs(accountingTotal(stats) - 1) < 1e-12);
        assert.strictEqual(stats.threshold, 0);
    });

    it('exposes exhaustive mode through the public stats API', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const stats = await engine.getStats({
            item: 'mace',
            material: 'mace',
            xp: 1,
            threshold: 1,
            maxIterations: 1,
            exhaustive: true,
            summaryLimit: 10,
            useCache: false
        });

        assert.strictEqual(stats.threshold, 0);
        assert.strictEqual(stats.accounting.pending, 0);
        assert.ok(stats.accounting.resolved > 0);
        assert.ok(Object.keys(stats.combos).length > 0);
        assert.ok(Math.abs(accountingTotal(stats) - 1) < 1e-12);
    });

    it('uses merged graph sharing for vanilla no-clue exhaustive public searches', async () => {
        const engine = EngineFactory.createForVersion('1.7.2');
        const instrumentation = createInstrumentation();

        const result = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            exhaustive: true,
            instrumentation,
            useCache: false
        });

        const search = result.instrumentation?.search;
        assert.ok(search);
        assert.strictEqual(result.snapshot.pendingCount, 0);
        assert.strictEqual(search.exactPoolCount, 8);
        assert.strictEqual(search.sharedGraphCount, 3);
        assert.strictEqual(search.mergedPoolCount, 5);
        assert.ok((search.pendingMergeCount ?? 0) > 0);
        assert.ok((search.lateForwardCount ?? 0) > 0);
    });

    it('uses merged graph sharing for clue-conditioned exhaustive public searches', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const instrumentation = createInstrumentation();

        const result = await engine.searchToCheckpoint({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            clue: 'Sharpness IV',
            exhaustive: true,
            instrumentation,
            useCache: false
        });

        assert.ok((result.instrumentation?.search?.exactPoolCount ?? 0) > 0);
        assert.strictEqual(result.snapshot.pendingCount, 0);
    });

    it('uses the default stats checkpoint for simple stats calls', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const checkpoint = getDefaultStatsCheckpoint(false);

        const instrumentation = {
            poolCache: { hits: 0, misses: 0 },
            distCache: { hits: 0, misses: 0 },
            totalIterations: 0,
            totalPrunedNodes: 0,
            roundingErrorEvents: 0,
            levelsProcessed: 0,
            levelsFullyResolved: 0,
            fullyResolved: false
        };
        const stats = await engine.getStats({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            summaryLimit: 10,
            instrumentation
        });

        assert.strictEqual(stats.threshold, checkpoint.threshold);
        assert.ok((stats.instrumentation?.totalIterations ?? 0) <= checkpoint.limit);
    });

    it('requires uncappedResults for summary limits above the normal export cap', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        await assert.rejects(
            () => engine.getStats({
                item: 'sword',
                material: 'diamond',
                xp: 30,
                summaryLimit: ENGINE_LIMITS.RESULT_ENTRY_SAFETY_CAP + 1
            }),
            /uncappedResults/
        );

        const stats = await engine.getStats({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            summaryLimit: ENGINE_LIMITS.RESULT_ENTRY_SAFETY_CAP + 1,
            uncappedResults: true
        });
        assert.ok(Object.keys(stats.combos).length > 0);
    });

    it('omits classified-mass targets from named refinement checkpoints by default', () => {
        const checkpoint = getSearchCheckpointForRefinement('ultra', true);

        assert.strictEqual(checkpoint.targetClassifiedMass, undefined);
    });

    it('supports per-checkpoint classified-mass targets', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();
        const snapshots: SearchResult[] = [];
        const instrumentation = {
            poolCache: { hits: 0, misses: 0 },
            distCache: { hits: 0, misses: 0 },
                totalIterations: 0,
            totalPrunedNodes: 0,
            roundingErrorEvents: 0,
            levelsProcessed: 0,
            levelsFullyResolved: 0,
            fullyResolved: false
        };

        await engine.searchSequentialCheckpoints({
            item: 'book',
            material: 'book',
            xp: 30,
            checkpoints: [
                { threshold: 0, limit: 100_000, targetClassifiedMass: 0.2 },
                { threshold: 0, limit: 100_000, targetClassifiedMass: 0.4 }
            ],
            instrumentation,
            onCheckpointComplete: result => {
                snapshots.push(result);
            }
        });

        assert.deepStrictEqual(snapshots.length, 2);
        assert.ok((1 - snapshots[0]!.snapshot.mass.pending) >= 0.2);
        assert.ok((1 - snapshots[1]!.snapshot.mass.pending) >= 0.4);
        assert.ok(snapshots[1]!.snapshot.iterations > snapshots[0]!.snapshot.iterations);
        assert.ok(snapshots[1]!.snapshot.mass.pending > 0);
        assert.strictEqual(snapshots[0]!.instrumentation?.exitReason, 'mass');
        assert.strictEqual(snapshots[1]!.instrumentation?.exitReason, 'mass');
    });

    it('supports direct classified-mass targets and reports the last expanded node mass', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const result = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            targetClassifiedMass: 0.25,
            instrumentation: {
                poolCache: { hits: 0, misses: 0 },
                distCache: { hits: 0, misses: 0 },
                totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });

        assert.ok((1 - result.snapshot.mass.pending) >= 0.25);
        assert.strictEqual(result.instrumentation?.exitReason, 'mass');
        assert.ok(result.snapshot.lastExpandedMass > 0n);
        assert.ok((result.instrumentation?.search?.lastExpandedMass ?? 0) > 0);
    });

    it('rejects public non-exhaustive searches without any bounded stop condition', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        await assert.rejects(
            () => engine.searchToCheckpoint({
                item: 'book',
                material: 'book',
                xp: 30,
                threshold: 0
            }),
            /no bounded stop condition/
        );
    });

    it('rejects NaN probability controls with descriptive validation errors', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        await assert.rejects(
            () => engine.searchToCheckpoint({
                item: 'book',
                material: 'book',
                xp: 30,
                threshold: Number.NaN,
                maxIterations: 1
            }),
            /Invalid threshold: NaN\. Threshold must be between 0 and 1\.0\./
        );

        await assert.rejects(
            () => engine.searchToCheckpoint({
                item: 'book',
                material: 'book',
                xp: 30,
                targetClassifiedMass: Number.NaN
            }),
            /Invalid targetClassifiedMass: NaN\. Must be between 0 and 1\.0\./
        );

        await assert.rejects(
            () => engine.searchSequentialCheckpoints({
                item: 'book',
                material: 'book',
                xp: 30,
                checkpoints: [{ threshold: Number.NaN, limit: 1 }],
                onCheckpointComplete: () => {}
            }),
            /Invalid checkpoint threshold: NaN\. Threshold must be between 0 and 1\.0\./
        );

        await assert.rejects(
            () => engine.searchSequentialCheckpoints({
                item: 'book',
                material: 'book',
                xp: 30,
                checkpoints: [{ threshold: 0, limit: 1, targetClassifiedMass: Number.NaN }],
                onCheckpointComplete: () => {}
            }),
            /Invalid checkpoint targetClassifiedMass: NaN\. Must be between 0 and 1\.0\./
        );
    });

    it('streams sequential checkpoints with monotonic resolved mass', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();
        const accuracies: number[] = [];

        await engine.searchSequentialCheckpoints({
            item: 'book',
            material: 'book',
            xp: 30,
            checkpoints: [
                { threshold: 0, limit: 100 },
                { threshold: 0, limit: 300 },
                { threshold: 0, limit: 600 }
            ],
            onCheckpointComplete: result => {
                accuracies.push(result.snapshot.mass.resolved);
            }
        });

        assert.deepStrictEqual(accuracies.length, 3);
        assert.ok(accuracies[0]! > 0);
        assert.ok(accuracies[1]! > accuracies[0]!);
        assert.ok(accuracies[2]! > accuracies[1]!);
    });

    it('supports clue-conditioned requests through the search path', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');

        const stats = await engine.getStats({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            clue: 'Sharpness III',
            threshold: 0,
            maxIterations: 10_000
        });

        assert.ok(stats.clue);
        assert.strictEqual(stats.clue.idAndRank, 3);
        assert.ok(stats.clue.knownSpace > 0);
        assert.ok(stats.accounting.resolved > 0);
        assert.ok(stats.accounting.clueIncompatible > 0);
        assert.ok(Math.abs(accountingTotal(stats) - 1) < 1e-12);
        assert.ok(Object.keys(stats.combos).length > 0);
    });

    it('projects factorized pending frontier summaries and search instrumentation through the search execution service', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const instrumentation = {
            poolCache: { hits: 0, misses: 0 },
            distCache: { hits: 0, misses: 0 },
                totalIterations: 0,
            totalPrunedNodes: 0,
            roundingErrorEvents: 0,
            levelsProcessed: 0,
            levelsFullyResolved: 0,
            fullyResolved: false
        };

        const result = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 1,
            instrumentation
        });

        assert.strictEqual(result.snapshot.frontier.kind, ENGINE_FRONTIER_KIND.FACTORIZED);
        assert.strictEqual(result.snapshot.pendingEntries.length, 0);
        assert.ok(result.snapshot.pendingAggregates);
        assert.ok(result.snapshot.mass.pending > 0);
        assert.ok(result.instrumentation?.search);
        assert.ok(result.instrumentation.search.graphCount > 0);
        assert.strictEqual(result.instrumentation.search.pendingEntryCount, result.snapshot.pendingCount);
        assert.ok(result.instrumentation.search.canImprove);
    });

    it('aborts checkpoint searches through the search execution service', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const controller = new AbortController();
        controller.abort();

        await assert.rejects(
            () => engine.searchToCheckpoint({
                    item: 'sword',
                material: 'diamond',
                xp: 30,
                threshold: 0,
                maxIterations: 10_000,
                signal: controller.signal
            }),
            /Aborted/
        );
    });

    it('aborts Flex rank-merge checkpoint searches after yielding between chunks', async () => {
        const engine = EngineFactory.createForVersion('1.7.2');
        const controller = new AbortController();

        const search = engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            exhaustive: true,
            signal: controller.signal
        });
        setTimeout(() => controller.abort(), 0);

        await assert.rejects(
            () => search,
            /Aborted/
        );
    });

    it('resumes XP-cell runs across one-at-a-time checkpoint calls', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const first = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 50,
            instrumentation: {
                poolCache: { hits: 0, misses: 0 },
                distCache: { hits: 0, misses: 0 },
                        totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });

        const resumed = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 10,
            instrumentation: {
                poolCache: { hits: 0, misses: 0 },
                distCache: { hits: 0, misses: 0 },
                        totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });

        assert.strictEqual(first.instrumentation?.totalIterations, 50);
        assert.strictEqual(resumed.instrumentation?.totalIterations, 50, 'lower follow-up limit should return the already-advanced cached run');
        assert.ok((resumed.instrumentation?.search?.runCacheHits ?? 0) >= 1);

        engine.resetCaches();
        const fresh = await engine.searchToCheckpoint({
            item: 'book',
            material: 'book',
            xp: 30,
            threshold: 0,
            maxIterations: 10,
            instrumentation: {
                poolCache: { hits: 0, misses: 0 },
                distCache: { hits: 0, misses: 0 },
                        totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });

        assert.strictEqual(fresh.instrumentation?.totalIterations, 10);
    });

    it('omits obsolete structural graph-cache counters on the default runtime', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        engine.resetCaches();

        const result = await engine.searchToCheckpoint({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            threshold: 0,
            maxIterations: 1,
            useCache: false,
            instrumentation: {
                poolCache: { hits: 0, misses: 0 },
                distCache: { hits: 0, misses: 0 },
                        totalIterations: 0,
                totalPrunedNodes: 0,
                roundingErrorEvents: 0,
                levelsProcessed: 0,
                levelsFullyResolved: 0,
                fullyResolved: false
            }
        });

        const searchInstrumentation = result.instrumentation?.search as Record<string, unknown> | undefined;
        assert.ok(searchInstrumentation);
        assert.ok(!Object.prototype.hasOwnProperty.call(searchInstrumentation, 'graphCacheHits'));
        assert.ok(!Object.prototype.hasOwnProperty.call(searchInstrumentation, 'graphCacheMisses'));
    });

});

function createCacheFillCases(limit: number): CacheFillCase[] {
    const cases: CacheFillCase[] = [];

    for (const version of getRegistryVersionBoundaries(DATA)) {
        const registry = RegistryFactory.build(version);
        for (const item of Object.keys(registry.itemPool)) {
            for (const material of getEligibleMaterials(registry, item)) {
                cases.push({ registry, item, material, xp: 1 });
                if (cases.length >= limit) return cases;
            }
        }
    }

    return cases;
}

function getFlexSearchRunCacheSize(service: SearchExecutionService): number {
    return (service as unknown as SearchExecutionServiceInternals).flexSearchRunCache.size;
}
