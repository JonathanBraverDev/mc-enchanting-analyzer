import { performance } from 'node:perf_hooks';
import { RegistryFactory } from '#core/factory.js';
import { EngineFactory } from '#engine/factory.js';
import type { RegistryMutation } from '#types/domain.js';

type Backend = 'plex' | 'flex' | 'concrete';
type Engine = ReturnType<typeof EngineFactory.createForVersion>;

type SearchRequest = {
    readonly item: string;
    readonly material: string;
    readonly xp: number;
    readonly threshold: bigint;
    readonly probabilityFloor: bigint;
    readonly exhaustive?: boolean;
    readonly maxIterations?: number;
    readonly clue?: string;
};

type BenchmarkCase = {
    readonly label: string;
    readonly mode: 'plex-parity' | 'concrete-superiority';
    readonly runs: number;
    readonly engine: () => Engine;
    readonly req: SearchRequest;
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

const ADVERSARIAL_SWORD_CYCLE: RegistryMutation[] = [
    { type: 'addConflictRule', rule: { enchants: ['Smite', 'Looting'], valid_from: '1.0' } },
    { type: 'addConflictRule', rule: { enchants: ['Looting', 'Unbreaking'], valid_from: '1.0' } },
    { type: 'addConflictRule', rule: { enchants: ['Unbreaking', 'Sharpness'], valid_from: '1.0' } }
];

const CLOSE_DELTA_LIMIT = 1_000_000_000_000n;

const CASES: readonly BenchmarkCase[] = Object.freeze([
    {
        label: 'modern sword xp30 exhaustive',
        mode: 'plex-parity',
        runs: 7,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'sword', material: 'diamond', xp: 30, exhaustive: true, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern bow xp30 exhaustive',
        mode: 'plex-parity',
        runs: 7,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'bow', material: 'bow', xp: 30, exhaustive: true, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern pickaxe xp30 exhaustive',
        mode: 'plex-parity',
        runs: 7,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'pickaxe', material: 'diamond', xp: 30, exhaustive: true, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern book xp30 20k floor0',
        mode: 'plex-parity',
        runs: 5,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'book', material: 'book', xp: 30, maxIterations: 20_000, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern book xp30 50k floor0',
        mode: 'plex-parity',
        runs: 5,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'book', material: 'book', xp: 30, maxIterations: 50_000, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern book xp30 100k floor0',
        mode: 'plex-parity',
        runs: 3,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'book', material: 'book', xp: 30, maxIterations: 100_000, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'legacy single-book 1.4.6 xp30 20k floor0',
        mode: 'plex-parity',
        runs: 5,
        engine: () => EngineFactory.createForVersion('1.4.6'),
        req: { item: 'book', material: 'book', xp: 30, maxIterations: 20_000, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern sword xp30 clue Sharpness III 20k',
        mode: 'concrete-superiority',
        runs: 5,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'sword', material: 'diamond', xp: 30, clue: 'Sharpness III', maxIterations: 20_000, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'modern book xp30 clue Sharpness III 20k',
        mode: 'concrete-superiority',
        runs: 5,
        engine: () => EngineFactory.createForVersion('1.21.11'),
        req: { item: 'book', material: 'book', xp: 30, clue: 'Sharpness III', maxIterations: 20_000, threshold: 0n, probabilityFloor: 0n }
    },
    {
        label: 'adversarial mutated sword xp30 exhaustive',
        mode: 'plex-parity',
        runs: 7,
        engine: () => EngineFactory.create(RegistryFactory.buildWithMutations('1.21.11', ADVERSARIAL_SWORD_CYCLE)),
        req: { item: 'sword', material: 'diamond', xp: 30, exhaustive: true, threshold: 0n, probabilityFloor: 0n }
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
            structuralPending: result.instrumentation?.search?.plexStructuralPendingEntryCount
                ?? result.instrumentation?.search?.flexStructuralPendingEntryCount,
            projectionLoss: result.instrumentation?.search?.plexProjectionLoss
                ?? result.instrumentation?.search?.flexProjectionLoss,
            flexIdentityMode: result.instrumentation?.search?.flexStateIdentityMode,
            resolved: result.snapshot.mass.units?.resolved,
            pending: result.snapshot.mass.units?.pending,
            rounding: result.snapshot.mass.units?.rounding
        }
    };
}

function timingPass(plexMedian: number, flexMedian: number): boolean {
    if (plexMedian < 10) return flexMedian <= plexMedian + 1;
    return flexMedian <= plexMedian;
}

async function runCase(testCase: BenchmarkCase): Promise<readonly string[]> {
    const engine = testCase.engine();
    const failures: string[] = [];

    await runBackend(engine, 'plex', testCase.req);
    await runBackend(engine, 'flex', testCase.req);

    const plexTimes: number[] = [];
    const flexTimes: number[] = [];
    let finalPlex = await runBackend(engine, 'plex', testCase.req);
    let finalFlex = await runBackend(engine, 'flex', testCase.req);

    for (let run = 0; run < testCase.runs; run++) {
        if (run % 2 === 0) {
            finalPlex = await runBackend(engine, 'plex', testCase.req);
            finalFlex = await runBackend(engine, 'flex', testCase.req);
        } else {
            finalFlex = await runBackend(engine, 'flex', testCase.req);
            finalPlex = await runBackend(engine, 'plex', testCase.req);
        }
        plexTimes.push(finalPlex.ms);
        flexTimes.push(finalFlex.ms);
    }

    const plexMedian = median(plexTimes);
    const flexMedian = median(flexTimes);
    const flexVsPlex = mapDelta(finalPlex.result.combos, finalFlex.result.combos);
    const ratio = flexMedian / plexMedian;

    console.log(`\n${testCase.label}`);
    console.log('plex timing', summarizeTimes(plexTimes));
    console.log('flex timing', { ...summarizeTimes(flexTimes), ratio: Number(ratio.toFixed(3)) });
    console.log('plex summary', finalPlex.summary);
    console.log('flex summary', finalFlex.summary);
    console.log('flex vs plex delta', printableDelta(flexVsPlex));

    if (!timingPass(plexMedian, flexMedian)) {
        failures.push(`Flex median ${Math.round(flexMedian)}ms slower than Plex median ${Math.round(plexMedian)}ms`);
    }

    if (testCase.mode === 'plex-parity') {
        if (flexVsPlex.maxDelta > CLOSE_DELTA_LIMIT) {
            failures.push(`Flex/Plex max delta ${flexVsPlex.maxDelta.toString()} exceeds ${CLOSE_DELTA_LIMIT.toString()}`);
        }
        return failures;
    }

    const concrete = await runBackend(engine, 'concrete', testCase.req);
    const plexVsConcrete = mapDelta(concrete.result.combos, finalPlex.result.combos);
    const flexVsConcrete = mapDelta(concrete.result.combos, finalFlex.result.combos);
    console.log('concrete summary', concrete.summary);
    console.log('plex vs concrete delta', printableDelta(plexVsConcrete));
    console.log('flex vs concrete delta', printableDelta(flexVsConcrete));

    if (flexVsConcrete.maxDelta > plexVsConcrete.maxDelta) {
        failures.push('Flex max delta vs concrete is worse than Plex');
    }
    if (flexVsConcrete.sumDelta >= plexVsConcrete.sumDelta) {
        failures.push('Flex sum delta vs concrete is not better than Plex');
    }

    return failures;
}

const failures: string[] = [];
for (const testCase of CASES) {
    const caseFailures = await runCase(testCase);
    failures.push(...caseFailures.map(failure => `${testCase.label}: ${failure}`));
}

if (failures.length > 0) {
    console.log('\nFLEX_SUPERIORITY_CHECK FAIL');
    for (const failure of failures) console.log(`- ${failure}`);
    process.exitCode = 1;
} else {
    console.log('\nFLEX_SUPERIORITY_CHECK PASS');
}
