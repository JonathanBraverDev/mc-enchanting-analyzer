import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import inspector from 'node:inspector';
import { EngineFactory } from '#engine/factory.js';
import { ENGINE_FRONTIER_KIND } from '#lib/search/SearchSnapshot.js';
import type { EngineInstrumentation, SearchResult } from '#types/index.js';

type Backend = 'concrete' | 'flex';

interface CliOptions {
    readonly version: string;
    readonly item: string;
    readonly material: string;
    readonly xp: number;
    readonly targetClassifiedMass: number;
    readonly clue?: string | undefined;
    readonly outDir: string;
}

interface ProfileRunSummary {
    readonly backend: Backend;
    readonly ms: number;
    readonly profilePath: string;
    readonly iterations: number;
    readonly frontierKind: string;
    readonly nativeFrontierEntries: number;
    readonly compatibilityPendingEntries: number;
    readonly resultsSize: number;
    readonly resolvedUnits: string;
    readonly pendingUnits: string;
    readonly roundingUnits: string;
    readonly classifiedMass: number;
    readonly pendingMass: number;
    readonly graphCount: number;
    readonly activeResidueCount: number;
    readonly activeResidueMass: string;
    readonly flexIdentityMode?: string | undefined;
    readonly flexProjectionLoss?: number | undefined;
}

const DEFAULT_OPTIONS: CliOptions = {
    version: '1.21.11',
    item: 'book',
    material: 'book',
    xp: 30,
    targetClassifiedMass: 0.995,
    outDir: 'tmp/flex-native-profile'
};

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    await fs.mkdir(options.outDir, { recursive: true });

    await runUnprofiled(options, 'concrete');
    await runUnprofiled(options, 'flex');

    const concrete = await runProfiled(options, 'concrete');
    const flex = await runProfiled(options, 'flex');
    const comparison = createComparison(concrete, flex);
    const summaryPath = path.join(options.outDir, 'summary.json');
    await fs.writeFile(summaryPath, JSON.stringify({ options, concrete, flex, comparison }, jsonReplacer, 2));

    console.log(`\nNative Flex profile output: ${options.outDir}`);
    console.log(`Summary JSON: ${summaryPath}`);
    printSummary(concrete, flex, comparison);
    console.log('\nAnalyze CPU profiles with:');
    console.log(`  node --import tsx scripts/analyze_cpu_profile.ts --top 12 ${concrete.profilePath} ${flex.profilePath}`);
}

function parseArgs(args: readonly string[]): CliOptions {
    let options = DEFAULT_OPTIONS;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        const next = () => {
            const value = args[++index];
            if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
            return value;
        };

        switch (arg) {
            case '--version':
                options = { ...options, version: next() };
                break;
            case '--item':
                options = { ...options, item: next() };
                break;
            case '--material':
                options = { ...options, material: next() };
                break;
            case '--xp':
                options = { ...options, xp: parsePositiveInteger(next(), '--xp') };
                break;
            case '--target':
            case '--target-classified-mass':
                options = { ...options, targetClassifiedMass: parseProbability(next(), arg) };
                break;
            case '--clue':
                options = { ...options, clue: next() };
                break;
            case '--out':
                options = { ...options, outDir: next() };
                break;
            case '--help':
            case '-h':
                printUsage();
                process.exit(0);
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }

    return options;
}

function printUsage(): void {
    console.log([
        'Usage: node --import tsx scripts/profile_flex_native.ts [options]',
        '',
        'Profiles concrete V7 and native Flex at the same classified-mass target,',
        'then writes one CPU profile per backend plus a node/work summary.',
        '',
        'Options:',
        '  --version VERSION        Default: 1.21.11',
        '  --item ITEM              Default: book',
        '  --material MATERIAL      Default: book',
        '  --xp LEVEL               Default: 30',
        '  --target VALUE           Classified-mass stop. Default: 0.995',
        '  --clue "Sharpness III"   Optional exact clue',
        '  --out DIR                Default: tmp/flex-native-profile'
    ].join('\n'));
}

function parsePositiveInteger(value: string, label: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer, got ${value}.`);
    return parsed;
}

function parseProbability(value: string, label: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) throw new Error(`${label} must be in (0, 1], got ${value}.`);
    return parsed;
}

async function runUnprofiled(options: CliOptions, backend: Backend): Promise<void> {
    await runSearch(options, backend);
}

async function runProfiled(options: CliOptions, backend: Backend): Promise<ProfileRunSummary> {
    const session = new inspector.Session();
    session.connect();

    try {
        await postInspector(session, 'Profiler.enable');
        await postInspector(session, 'Profiler.start');

        const started = performance.now();
        const result = await runSearch(options, backend);
        const ms = performance.now() - started;

        const stopped = await postInspector<{ profile: unknown }>(session, 'Profiler.stop');
        const profilePath = path.join(options.outDir, `${backend}-${createCaseSlug(options)}.cpuprofile`);
        await fs.writeFile(profilePath, JSON.stringify(stopped.profile));

        return summarizeRun(backend, ms, profilePath, result);
    } finally {
        session.disconnect();
    }
}

function postInspector<T = Record<string, unknown>>(
    session: inspector.Session,
    method: string,
    params: Record<string, unknown> = {}
): Promise<T> {
    return new Promise((resolve, reject) => {
        session.post(method, params, (error, result) => {
            if (error) reject(error);
            else resolve(result as T);
        });
    });
}

async function runSearch(options: CliOptions, _backend: Backend): Promise<SearchResult> {
    const engine = EngineFactory.createForVersion(options.version);
    return engine.searchToCheckpoint({
        item: options.item,
        material: options.material,
        xp: options.xp,
        ...(options.clue ? { clue: options.clue } : {}),
        targetClassifiedMass: options.targetClassifiedMass,
        probabilityFloor: 0n,
        useCache: false,
        instrumentation: createInstrumentation()
    });
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

function summarizeRun(
    backend: Backend,
    ms: number,
    profilePath: string,
    result: SearchResult
): ProfileRunSummary {
    const frontier = result.snapshot.frontier;
    const nativeFrontierEntries = frontier.kind === ENGINE_FRONTIER_KIND.MATERIALIZED
        ? frontier.entries.length
        : frontier.kind === ENGINE_FRONTIER_KIND.FACTORIZED
            ? result.snapshot.pendingCount
            : 0;
    const units = result.snapshot.mass.units;

    return {
        backend,
        ms,
        profilePath,
        iterations: result.snapshot.iterations,
        frontierKind: frontier.kind,
        nativeFrontierEntries,
        compatibilityPendingEntries: result.snapshot.pendingEntries.length,
        resultsSize: result.snapshot.results.size,
        resolvedUnits: units?.resolved ?? '0',
        pendingUnits: units?.pending ?? '0',
        roundingUnits: units?.rounding ?? '0',
        classifiedMass: 1 - result.snapshot.mass.pending,
        pendingMass: result.snapshot.mass.pending,
        graphCount: result.snapshot.graphCount,
        activeResidueCount: result.snapshot.activeResidueCount,
        activeResidueMass: result.snapshot.activeResidueMass.toString(),
        flexIdentityMode: result.instrumentation?.search?.flexStateIdentityMode,
        flexProjectionLoss: result.instrumentation?.search?.flexProjectionLoss
    };
}

function createComparison(concrete: ProfileRunSummary, flex: ProfileRunSummary): Record<string, number> {
    return {
        timeRatioFlexOverConcrete: flex.ms / concrete.ms,
        iterationRatioFlexOverConcrete: flex.iterations / concrete.iterations,
        concreteIterationsPerMs: concrete.iterations / concrete.ms,
        flexIterationsPerMs: flex.iterations / flex.ms,
        iterationThroughputRatioFlexOverConcrete: (flex.iterations / flex.ms) / (concrete.iterations / concrete.ms),
        frontierEntryRatioFlexOverConcrete: flex.nativeFrontierEntries / Math.max(1, concrete.nativeFrontierEntries),
        resultSizeRatioFlexOverConcrete: flex.resultsSize / Math.max(1, concrete.resultsSize)
    };
}

function printSummary(
    concrete: ProfileRunSummary,
    flex: ProfileRunSummary,
    comparison: Record<string, number>
): void {
    console.log('\nWORK SUMMARY');
    console.table([
        printableRun(concrete),
        printableRun(flex)
    ]);

    console.log('\nCOMPARISON');
    for (const [key, value] of Object.entries(comparison)) {
        console.log(`${key}: ${value.toFixed(3)}`);
    }
}

function printableRun(summary: ProfileRunSummary): Record<string, string | number | undefined> {
    return {
        backend: summary.backend,
        ms: Math.round(summary.ms),
        iterations: summary.iterations,
        iterationsPerMs: Number((summary.iterations / summary.ms).toFixed(2)),
        frontierKind: summary.frontierKind,
        nativeFrontierEntries: summary.nativeFrontierEntries,
        compatibilityPendingEntries: summary.compatibilityPendingEntries,
        resultsSize: summary.resultsSize,
        pendingMass: Number(summary.pendingMass.toFixed(6)),
        graphCount: summary.graphCount,
        activeResidues: summary.activeResidueCount,
        flexIdentityMode: summary.flexIdentityMode
    };
}

function createCaseSlug(options: CliOptions): string {
    const parts = [
        options.version,
        options.item,
        options.material,
        `xp${options.xp}`,
        `classified${String(options.targetClassifiedMass).replace('.', 'p')}`,
        ...(options.clue ? [options.clue.toLowerCase().replace(/[^a-z0-9]+/g, '-')] : [])
    ];
    return parts.join('-');
}

function jsonReplacer(_key: string, value: unknown): unknown {
    return typeof value === 'bigint' ? value.toString() : value;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
