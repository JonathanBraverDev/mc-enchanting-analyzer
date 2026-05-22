import { performance } from 'node:perf_hooks';
import { RegistryFactory } from '#core/factory.js';
import { EngineFactory } from '#engine/factory.js';
import type { RegistryMutation } from '#types/domain.js';

type Backend = 'flex' | 'concrete';
type Engine = ReturnType<typeof EngineFactory.createForVersion>;

type SearchRequest = {
    readonly item: string;
    readonly material: string;
    readonly xp: number;
    readonly threshold: bigint;
    readonly probabilityFloor: bigint;
    readonly exhaustive?: boolean;
    readonly maxIterations?: number;
    readonly drainEqualMassBand?: boolean;
    readonly clue?: string;
};

type BenchmarkCase = {
    readonly label: string;
    readonly runs: number;
    readonly engine: () => Engine;
    readonly req: SearchRequest;
    // Concrete SearchRun is the only semantic reference in this benchmark.
    readonly enforceConcreteClose?: boolean;
};

type RunResult = {
    readonly ms: number;
    readonly result: Awaited<ReturnType<Engine['searchToCheckpoint']>>;
    readonly summary: Record<string, unknown>;
};

type Delta = {
    readonly diffKeys: number;
    readonly maxDelta: bigint;
    readonly sumDelta: bigint;
    readonly keys: number;
};

type AdversarialBookSpot = {
    readonly label: string;
    readonly baseConflict: readonly [string, string];
    readonly bridge: readonly [string, string];
};

const ADVERSARIAL_BOOK_SPOTS: readonly AdversarialBookSpot[] = Object.freeze([
    { label: 'damage', baseConflict: ['Sharpness', 'Smite'], bridge: ['Looting', 'Unbreaking'] },
    { label: 'tool', baseConflict: ['Fortune', 'Silk Touch'], bridge: ['Efficiency', 'Power'] },
    { label: 'protection', baseConflict: ['Protection', 'Fire Protection'], bridge: ['Thorns', 'Respiration'] },
    { label: 'trident', baseConflict: ['Riptide', 'Loyalty'], bridge: ['Aqua Affinity', 'Depth Strider'] },
    { label: 'crossbow', baseConflict: ['Multishot', 'Piercing'], bridge: ['Quick Charge', 'Flame'] }
]);

function createAdversarialBookMutations(spots: readonly AdversarialBookSpot[]): RegistryMutation[] {
    return spots.flatMap(spot => {
        const [leftBase, rightBase] = spot.baseConflict;
        const [leftBridge, rightBridge] = spot.bridge;
        return [
            { type: 'addConflictRule', rule: { enchants: [rightBase, leftBridge], valid_from: '1.0' } },
            { type: 'addConflictRule', rule: { enchants: [leftBridge, rightBridge], valid_from: '1.0' } },
            { type: 'addConflictRule', rule: { enchants: [rightBridge, leftBase], valid_from: '1.0' } }
        ];
    });
}

const CONCRETE_DELTA_LIMIT = 1_000_000_000_000n;
const TIMING_REGRESSION_TOLERANCE_RATIO = 1.05;

const CASES: readonly BenchmarkCase[] = Object.freeze([
    {
        label: 'modern sword xp30 exhaustive',
        runs: 7,
        enforceConcreteClose: true,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'sword', material: 'diamond', xp: 30, exhaustive: true, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern bow xp30 exhaustive',
        runs: 7,
        enforceConcreteClose: true,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'bow', material: 'bow', xp: 30, exhaustive: true, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern pickaxe xp30 exhaustive',
        runs: 7,
        enforceConcreteClose: true,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'pickaxe', material: 'diamond', xp: 30, exhaustive: true, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern book xp30 20k floor0',
        runs: 5,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'book', material: 'book', xp: 30, maxIterations: 20_000, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern book xp30 50k floor0',
        runs: 5,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'book', material: 'book', xp: 30, maxIterations: 50_000, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern book xp30 100k floor0',
        runs: 3,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'book', material: 'book', xp: 30, maxIterations: 100_000, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'legacy single-book 1.4.6 xp30 20k floor0',
        runs: 5,
        enforceConcreteClose: true,
        engine: () => EngineFactory.createForVersion('1.4.6'),
        req: { item: 'book', material: 'book', xp: 30, maxIterations: 20_000, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern sword xp30 clue Sharpness III 20k',
        runs: 5,
        enforceConcreteClose: true,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'sword', material: 'diamond', xp: 30, clue: 'Sharpness III', maxIterations: 20_000, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern book xp30 clue Sharpness III 20k',
        runs: 5,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'book', material: 'book', xp: 30, clue: 'Sharpness III', maxIterations: 20_000, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'adversarial mutated book xp30 one spot 20k floor0',
        runs: 3,
        engine: () => EngineFactory.create(RegistryFactory.buildWithMutations('1.21.11', createAdversarialBookMutations(ADVERSARIAL_BOOK_SPOTS.slice(0, 1)))),
        req: { item: 'book', material: 'book', xp: 30, maxIterations: 20_000, drainEqualMassBand: true, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'adversarial mutated book xp30 two spots 20k floor0',
        runs: 3,
        engine: () => EngineFactory.create(RegistryFactory.buildWithMutations('1.21.11', createAdversarialBookMutations(ADVERSARIAL_BOOK_SPOTS.slice(0, 2)))),
        req: { item: 'book', material: 'book', xp: 30, maxIterations: 20_000, drainEqualMassBand: true, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'adversarial mutated book xp30 all spots 20k floor0',
        runs: 3,
        engine: () => EngineFactory.create(RegistryFactory.buildWithMutations('1.21.11', createAdversarialBookMutations(ADVERSARIAL_BOOK_SPOTS))),
        req: { item: 'book', material: 'book', xp: 30, maxIterations: 20_000, drainEqualMassBand: true, threshold: 0n, probabilityFloor: 0n }
    }
]);

function emptyInstrumentation() {
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

function median(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)]!;
}

function summarizeTimes(values: readonly number[]): Record<string, number> {
    return {
        min: Math.round(Math.min(...values)),
        median: Math.round(median(values)),
        mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
        max: Math.round(Math.max(...values))
    };
}

function mapDelta(left: ReadonlyMap<unknown, bigint>, right: ReadonlyMap<unknown, bigint>): Delta {
    const keys = new Set([...left.keys(), ...right.keys()]);
    let diffKeys = 0;
    let maxDelta = 0n;
    let sumDelta = 0n;

    for (const key of keys) {
        const leftValue = left.get(key) ?? 0n;
        const rightValue = right.get(key) ?? 0n;
        const delta = leftValue > rightValue ? leftValue - rightValue : rightValue - leftValue;
        if (delta > 0n) diffKeys++;
        if (delta > maxDelta) maxDelta = delta;
        sumDelta += delta;
    }

    return { diffKeys, maxDelta, sumDelta, keys: keys.size };
}

function printableDelta(delta: Delta): Record<string, string | number> {
    return {
        diffKeys: delta.diffKeys,
        maxDelta: delta.maxDelta.toString(),
        sumDelta: delta.sumDelta.toString(),
        keys: delta.keys
    };
}

async function runBackend(engine: Engine, backend: Backend, req: SearchRequest): Promise<RunResult> {
    const request = backend === 'concrete'
        ? { ...req, useCache: false, instrumentation: emptyInstrumentation() }
        : { ...req, searchBackend: backend, useCache: false, instrumentation: emptyInstrumentation() };
    const started = performance.now();
    const result = await engine.searchToCheckpoint(request);
    const ms = performance.now() - started;

    return {
        ms,
        result,
        summary: {
            iterations: result.snapshot.iterations,
            pendingEntries: result.snapshot.pendingEntries.length,
            structuralPending: result.instrumentation?.search?.flexStructuralPendingEntryCount,
            projectionLoss: result.instrumentation?.search?.flexProjectionLoss,
            flexIdentityMode: result.instrumentation?.search?.flexStateIdentityMode,
            resolved: result.snapshot.mass.units?.resolved,
            pending: result.snapshot.mass.units?.pending,
            rounding: result.snapshot.mass.units?.rounding
        }
    };
}

function timingPass(concreteMedian: number, flexMedian: number): boolean {
    if (concreteMedian < 10) return flexMedian < 10;
    return flexMedian <= concreteMedian * TIMING_REGRESSION_TOLERANCE_RATIO;
}

async function runCase(testCase: BenchmarkCase): Promise<readonly string[]> {
    const engine = testCase.engine();
    const failures: string[] = [];

    await runBackend(engine, 'concrete', testCase.req);
    await runBackend(engine, 'flex', testCase.req);

    const concreteTimes: number[] = [];
    const flexTimes: number[] = [];
    let finalConcrete = await runBackend(engine, 'concrete', testCase.req);
    let finalFlex = await runBackend(engine, 'flex', testCase.req);

    for (let run = 0; run < testCase.runs; run++) {
        if (run % 2 === 0) {
            finalConcrete = await runBackend(engine, 'concrete', testCase.req);
            finalFlex = await runBackend(engine, 'flex', testCase.req);
        } else {
            finalFlex = await runBackend(engine, 'flex', testCase.req);
            finalConcrete = await runBackend(engine, 'concrete', testCase.req);
        }
        concreteTimes.push(finalConcrete.ms);
        flexTimes.push(finalFlex.ms);
    }

    const concreteMedian = median(concreteTimes);
    const flexMedian = median(flexTimes);
    const flexVsConcrete = mapDelta(finalConcrete.result.combos, finalFlex.result.combos);
    const ratio = flexMedian / concreteMedian;

    console.log(`\n${testCase.label}`);
    console.log('concrete timing', summarizeTimes(concreteTimes));
    console.log('flex timing', { ...summarizeTimes(flexTimes), ratio: Number(ratio.toFixed(3)) });
    console.log('concrete summary', finalConcrete.summary);
    console.log('flex summary', finalFlex.summary);
    console.log('flex vs concrete delta', printableDelta(flexVsConcrete));

    if (!timingPass(concreteMedian, flexMedian)) {
        failures.push(`Flex median ${Math.round(flexMedian)}ms slower than concrete median ${Math.round(concreteMedian)}ms`);
    }

    if (testCase.enforceConcreteClose && flexVsConcrete.maxDelta > CONCRETE_DELTA_LIMIT) {
        failures.push(`Flex max delta vs concrete ${flexVsConcrete.maxDelta.toString()} exceeds ${CONCRETE_DELTA_LIMIT.toString()}`);
    }

    return failures;
}

const failures: string[] = [];
for (const testCase of CASES) {
    const caseFailures = await runCase(testCase);
    failures.push(...caseFailures.map(failure => `${testCase.label}: ${failure}`));
}

if (failures.length > 0) {
    console.log('\nFLEX_BENCHMARK_CHECK FAIL');
    for (const failure of failures) console.log(`- ${failure}`);
    process.exitCode = 1;
} else {
    console.log('\nFLEX_BENCHMARK_CHECK PASS');
}
