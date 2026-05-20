import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory } from '#core/factory.js';
import { getSearchCheckpointForRefinement } from '#core/config.js';
import { EngineFactory } from '#engine/factory.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { checkPlexReducedKeyInvariant } from '#lib/search/plex/PlexReducedKeyInvariant.js';
import type {
    BuiltRegistryState,
    EnchantStats,
    EngineInstrumentation,
    PackedCombo,
    SearchBackend,
    SearchCheckpoint,
    SearchResult
} from '#types/index.js';
import type { MassAccountingBreakdown } from '#types/mass.js';

// Temporary coexistence proof while Plex and concrete V7 both exist.
// Remove this harness when Plex is either retired or becomes the only search backend.
const PROBABILITY_TOLERANCE = 1e-12;

interface VanillaStatsParityCase {
    readonly version: string;
    readonly item: string;
    readonly material: string;
    readonly xp: number;
}

interface SequentialParityCase {
    readonly label: string;
    readonly version: string;
    readonly item: string;
    readonly material: string;
    readonly xp: number;
    readonly checkpoints: readonly SearchCheckpoint[];
}

interface MutatedParityCase {
    readonly label: string;
    readonly registry: BuiltRegistryState;
    readonly invariantOk: boolean;
}

const FULLY_RESOLVED_CASES: readonly VanillaStatsParityCase[] = Object.freeze([
    { version: '1.21.11', item: 'crossbow', material: 'crossbow', xp: 1 },
    { version: '1.21.11', item: 'mace', material: 'mace', xp: 15 },
    { version: '1.21.11', item: 'mace', material: 'mace', xp: 30 }
]);

const MASS_TARGET_CASES: readonly SequentialParityCase[] = Object.freeze([
    {
        label: 'XP 1 empty-frontier checkpoint',
        version: '1.21.11',
        item: 'crossbow',
        material: 'crossbow',
        xp: 1,
        checkpoints: Object.freeze([
            { threshold: 0, limit: 10_000, targetClassifiedMass: 0.5 },
            { threshold: 0, limit: 10_000, targetClassifiedMass: 0.9 }
        ])
    },
    {
        label: 'XP 15 mass target checkpoint',
        version: '1.21.11',
        item: 'mace',
        material: 'mace',
        xp: 15,
        checkpoints: Object.freeze([
            { threshold: 0, limit: 10_000, targetClassifiedMass: 0.5 },
            { threshold: 0, limit: 10_000, targetClassifiedMass: 0.8 }
        ])
    },
    {
        label: 'XP 30 mass target checkpoint',
        version: '1.21.11',
        item: 'sword',
        material: 'diamond',
        xp: 30,
        checkpoints: Object.freeze([
            { threshold: 0, limit: 20_000, targetClassifiedMass: 0.25 },
            { threshold: 0, limit: 20_000, targetClassifiedMass: 0.5 }
        ])
    }
]);

const REFINEMENT_CASES: readonly SequentialParityCase[] = Object.freeze([
    {
        label: 'sword refinement checkpoints',
        version: '1.21.11',
        item: 'sword',
        material: 'diamond',
        xp: 30,
        checkpoints: Object.freeze([
            getSearchCheckpointForRefinement('coarse', false),
            getSearchCheckpointForRefinement('standard', false)
        ])
    },
    {
        label: 'book refinement checkpoints',
        version: '1.21.11',
        item: 'book',
        material: 'book',
        xp: 30,
        checkpoints: Object.freeze([
            getSearchCheckpointForRefinement('coarse', true),
            getSearchCheckpointForRefinement('standard', true)
        ])
    }
]);

describe('Plex checkpoint parity', () => {
    it('matches concrete stats exactly for lightweight fully resolved XP checkpoints', async () => {
        for (const testCase of FULLY_RESOLVED_CASES) {
            const engine = EngineFactory.createForVersion(testCase.version);
            const [concrete, plex] = await Promise.all([
                engine.getStats({
                    ...testCase,
                    exhaustive: true,
                    uncappedResults: true,
                    useCache: false
                }),
                engine.getStats({
                    ...testCase,
                    exhaustive: true,
                    uncappedResults: true,
                    useCache: false,
                    searchBackend: 'plex'
                })
            ]);

            assertStatsParity(`${testCase.version} ${testCase.item}/${testCase.material} XP ${testCase.xp}`, concrete, plex);
        }
    });

    it('honors mass-target sequential checkpoint contracts at XP 1, 15, and 30', async () => {
        for (const testCase of MASS_TARGET_CASES) {
            const concrete = await runSequentialCase(testCase, 'concrete');
            const plex = await runSequentialCase(testCase, 'plex');

            assertSequentialContractParity(testCase, concrete, plex);
        }
    });

    it('honors refinement-style threshold checkpoints for representative item and book flows', async () => {
        for (const testCase of REFINEMENT_CASES) {
            const concrete = await runSequentialCase(testCase, 'concrete');
            const plex = await runSequentialCase(testCase, 'plex');

            assertSequentialContractParity(testCase, concrete, plex);
        }
    });

    it('matches concrete conditioned distributions for a stable clue-conditioned flow', async () => {
        const engine = EngineFactory.createForVersion('1.21.11');
        const [concrete, plex] = await Promise.all([
            engine.getStats({
                item: 'sword',
                material: 'diamond',
                xp: 30,
                clue: 'Sharpness III',
                exhaustive: true,
                uncappedResults: true,
                useCache: false
            }),
            engine.getStats({
                item: 'sword',
                material: 'diamond',
                xp: 30,
                clue: 'Sharpness III',
                exhaustive: true,
                uncappedResults: true,
                useCache: false,
                searchBackend: 'plex'
            })
        ]);

        assertConditionedStatsParity('1.21.11 sword/diamond XP 30 clue Sharpness III', concrete, plex);
    });

    it('matches concrete for mutated registries in both payload-aware fallback and reduced-key modes', async () => {
        for (const testCase of createMutatedCases()) {
            assertReducedKeyInvariant(testCase);

            const engine = EngineFactory.create(testCase.registry);
            const [concrete, plex] = await Promise.all([
                engine.getStats({
                    item: 'sword',
                    material: 'diamond',
                    xp: 1,
                    exhaustive: true,
                    uncappedResults: true,
                    useCache: false
                }),
                engine.getStats({
                    item: 'sword',
                    material: 'diamond',
                    xp: 1,
                    exhaustive: true,
                    uncappedResults: true,
                    useCache: false,
                    searchBackend: 'plex'
                })
            ]);

            assertStatsParity(`${testCase.label} mutated sword/diamond XP 1`, concrete, plex);
        }
    });
});

async function runSequentialCase(
    testCase: SequentialParityCase,
    backend: SearchBackend
): Promise<readonly SearchResult[]> {
    const engine = EngineFactory.createForVersion(testCase.version);
    const results: SearchResult[] = [];
    await engine.searchSequentialCheckpoints({
        item: testCase.item,
        material: testCase.material,
        xp: testCase.xp,
        checkpoints: [...testCase.checkpoints],
        instrumentation: createInstrumentation(),
        useCache: false,
        ...(backend === 'plex' ? { searchBackend: 'plex' as const } : {}),
        onCheckpointComplete: result => {
            results.push(result);
        }
    });
    return Object.freeze(results);
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

function assertSequentialContractParity(
    testCase: SequentialParityCase,
    concrete: readonly SearchResult[],
    plex: readonly SearchResult[]
): void {
    assert.strictEqual(concrete.length, testCase.checkpoints.length, `${testCase.label}: concrete checkpoint count`);
    assert.strictEqual(plex.length, testCase.checkpoints.length, `${testCase.label}: Plex checkpoint count`);

    let previousConcreteClassified = 0;
    let previousPlexClassified = 0;

    for (let index = 0; index < testCase.checkpoints.length; index++) {
        const checkpoint = testCase.checkpoints[index]!;
        const concreteResult = concrete[index]!;
        const plexResult = plex[index]!;
        const label = `${testCase.label} checkpoint ${index}`;

        assertCheckpointContract(concreteResult, checkpoint, 'concrete', `${label} concrete`);
        assertCheckpointContract(plexResult, checkpoint, 'plex', `${label} Plex`);
        assert.strictEqual(
            plexResult.instrumentation?.exitReason,
            concreteResult.instrumentation?.exitReason,
            `${label}: exit reason`
        );

        const concreteClassified = getClassifiedMass(concreteResult);
        const plexClassified = getClassifiedMass(plexResult);
        assert.ok(concreteClassified + PROBABILITY_TOLERANCE >= previousConcreteClassified, `${label}: concrete classified mass is monotonic`);
        assert.ok(plexClassified + PROBABILITY_TOLERANCE >= previousPlexClassified, `${label}: Plex classified mass is monotonic`);
        previousConcreteClassified = concreteClassified;
        previousPlexClassified = plexClassified;
    }
}

function assertCheckpointContract(
    result: SearchResult,
    checkpoint: SearchCheckpoint,
    backend: SearchBackend,
    label: string
): void {
    assert.strictEqual(result.instrumentation?.search?.backend, backend, `${label}: backend`);
    assert.strictEqual(result.combos.has(0 as PackedCombo), false, `${label}: public combo row 0`);
    assertApproximatelyEqual(result.threshold, checkpoint.threshold, `${label}: threshold`);
    assertAccountingConserved(result.snapshot.mass, `${label}: accounting`);

    const exitReason = result.instrumentation?.exitReason;
    if (exitReason === 'mass') {
        assert.notStrictEqual(checkpoint.targetClassifiedMass, undefined, `${label}: mass exit needs a mass target`);
        assert.ok(
            getClassifiedMass(result) + PROBABILITY_TOLERANCE >= Number(checkpoint.targetClassifiedMass),
            `${label}: classified mass target`
        );
    }

    if (exitReason === 'threshold') {
        assert.ok(checkpoint.threshold > 0, `${label}: threshold exit needs a positive threshold`);
        assert.ok(
            (result.instrumentation?.search?.largestPendingMass ?? Number.POSITIVE_INFINITY) < checkpoint.threshold,
            `${label}: largest pending mass is below threshold`
        );
    }

    if (exitReason === 'iterations') {
        assert.strictEqual(result.instrumentation?.totalIterations, checkpoint.limit, `${label}: iteration cap`);
    }
}

function assertStatsParity(label: string, concrete: EnchantStats, plex: EnchantStats): void {
    assert.strictEqual(plex.combos['0'], undefined, `${label}: Plex must not expose combo row 0`);
    assertApproximatelyEqual(plex.threshold, concrete.threshold, `${label}: threshold`);
    assertApproximatelyEqual(plex.accuracy, concrete.accuracy, `${label}: accuracy`);
    assertMassAccountingParity(label, concrete.accounting, plex.accounting);
    assertNumericRecordParity(`${label}: combos`, concrete.combos, plex.combos);
    assertNumericRecordParity(`${label}: any`, concrete.any, plex.any);
    assertNumericRecordParity(`${label}: ranks`, concrete.ranks, plex.ranks);
    assertNumericRecordParity(`${label}: count`, concrete.count, plex.count);
}

function assertConditionedStatsParity(label: string, concrete: EnchantStats, plex: EnchantStats): void {
    assert.strictEqual(plex.combos['0'], undefined, `${label}: Plex must not expose combo row 0`);
    assert.strictEqual(plex.clue?.idAndRank, concrete.clue?.idAndRank, `${label}: clue id`);
    assertNumericRecordParity(`${label}: conditioned combos`, concrete.combos, plex.combos);
    assertNumericRecordParity(`${label}: conditioned any`, concrete.any, plex.any);
    assertNumericRecordParity(`${label}: conditioned ranks`, concrete.ranks, plex.ranks);
    assertNumericRecordParity(`${label}: conditioned count`, concrete.count, plex.count);
}

function assertMassAccountingParity(label: string, concrete: MassAccountingBreakdown, plex: MassAccountingBreakdown): void {
    for (const bucket of [
        'resolved',
        'clueIncompatible',
        'pending',
        'sieved',
        'overflow',
        'capped',
        'rounding',
        'recoveredRounding',
        'recoveredSieved'
    ] as const) {
        assertApproximatelyEqual(plex[bucket], concrete[bucket], `${label}: accounting.${bucket}`);
    }
}

function assertNumericRecordParity(
    label: string,
    concrete: Record<string, number>,
    plex: Record<string, number>
): void {
    const concreteKeys = Object.keys(concrete).sort();
    const plexKeys = Object.keys(plex).sort();
    if (!sameStringList(concreteKeys, plexKeys)) {
        const concreteSet = new Set(concreteKeys);
        const plexSet = new Set(plexKeys);
        const concreteOnly = concreteKeys.filter(key => !plexSet.has(key)).slice(0, 10);
        const plexOnly = plexKeys.filter(key => !concreteSet.has(key)).slice(0, 10);
        assert.fail(`${label}: key mismatch; concreteOnly=${concreteOnly.join(',')} plexOnly=${plexOnly.join(',')}`);
    }

    for (const key of concreteKeys) {
        assertApproximatelyEqual(plex[key] ?? 0, concrete[key] ?? 0, `${label}.${key}`);
    }
}

function assertAccountingConserved(accounting: MassAccountingBreakdown, label: string): void {
    assertApproximatelyEqual(
        accounting.resolved
            + accounting.clueIncompatible
            + accounting.pending
            + accounting.sieved
            + accounting.overflow
            + accounting.capped
            + accounting.rounding,
        1,
        label
    );
}

function getClassifiedMass(result: SearchResult): number {
    return result.snapshot.mass.resolved + result.snapshot.mass.clueIncompatible;
}

function createMutatedCases(): readonly MutatedParityCase[] {
    return Object.freeze([
        {
            label: 'payload-aware fallback',
            invariantOk: false,
            registry: RegistryFactory.buildWithMutations('1.21.11', [
                { type: 'addConflictRule', rule: { enchants: ['Smite', 'Looting'], valid_from: '1.0' } },
                { type: 'addConflictRule', rule: { enchants: ['Looting', 'Unbreaking'], valid_from: '1.0' } },
                { type: 'addConflictRule', rule: { enchants: ['Unbreaking', 'Sharpness'], valid_from: '1.0' } }
            ])
        },
        {
            label: 'reduced-key safe',
            invariantOk: true,
            registry: RegistryFactory.buildWithMutations('1.21.11', {
                type: 'removeConflictRule',
                selector: { enchants: ['Smite', 'Sharpness'], valid_from: '1.0' }
            })
        }
    ]);
}

function assertReducedKeyInvariant(testCase: MutatedParityCase): void {
    const result = checkPlexReducedKeyInvariant({
        kernel: new RegistryKernel({
            registry: testCase.registry,
            item: 'sword',
            material: 'diamond'
        }),
        xp: 1,
        maxConflicts: 1
    });
    assert.strictEqual(result.ok, testCase.invariantOk, `${testCase.label}: reduced-key invariant`);
}

function assertApproximatelyEqual(actual: number, expected: number, label: string): void {
    const delta = Math.abs(actual - expected);
    assert.ok(
        delta <= PROBABILITY_TOLERANCE,
        `${label}: expected ${expected}, got ${actual}, delta ${delta}`
    );
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}
