import fs from 'node:fs/promises';
import inspector from 'node:inspector';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ClueValidator } from '#core/clue.js';
import { RegistryFactory, RegistryKernel, SearchRun } from '#lib/index.js';
import { GroupedFlexSearchRun, type FlexRunMemoryStats } from '#lib/search/flex/index.js';

type Backend = 'concrete' | 'flex';

interface ProfileCase {
    readonly name: string;
    readonly version: string;
    readonly item: string;
    readonly material: string;
    readonly xp: number;
    readonly targetClassifiedMass?: number | undefined;
    readonly exhaustive?: boolean | undefined;
    readonly clue?: string | undefined;
}

interface CliOptions {
    readonly outDir: string;
    readonly caseName?: string | undefined;
    readonly samplingInterval: number;
}

interface RunSummary {
    readonly backend: Backend;
    readonly caseName: string;
    readonly ms: number;
    readonly iterations: number;
    readonly resultsSize: number;
    readonly pendingEntries: number;
    readonly pendingMass: number;
    readonly activeResidueCount: number;
    readonly activeResidueMass: string;
    readonly heapProfilePath: string;
    readonly cpuProfilePath: string;
    readonly sampledAllocationBytes: number;
    readonly allocationBytesPerIteration: number;
    readonly gcMs: number;
    readonly gcShare: number;
    readonly cpuPhases: Record<string, PhaseSummary>;
    readonly topAllocators: readonly AllocationSummary[];
    readonly flexMemory?: FlexRunMemoryStats | undefined;
}

interface PhaseSummary {
    readonly ms: number;
    readonly share: number;
}

interface AllocationSummary {
    readonly frame: string;
    readonly bytes: number;
    readonly share: number;
}

interface CapturedRun {
    readonly ms: number;
    readonly iterations: number;
    readonly resultsSize: number;
    readonly pendingEntries: number;
    readonly pendingMass: number;
    readonly activeResidueCount: number;
    readonly activeResidueMass: string;
    readonly flexMemory?: FlexRunMemoryStats | undefined;
}

interface CpuProfile {
    readonly nodes: readonly CpuNode[];
    readonly samples?: readonly number[] | undefined;
    readonly timeDeltas?: readonly number[] | undefined;
}

interface CpuNode {
    readonly id: number;
    readonly callFrame: {
        readonly functionName: string;
        readonly url: string;
    };
    readonly children?: readonly number[] | undefined;
}

interface HeapProfileNode {
    readonly callFrame?: {
        readonly functionName?: string | undefined;
        readonly url?: string | undefined;
    } | undefined;
    readonly selfSize?: number | undefined;
    readonly children?: readonly HeapProfileNode[] | undefined;
}

interface HeapProfile {
    readonly head: HeapProfileNode;
}

const DEFAULT_OUT_DIR = 'tmp/flex-allocation-profile';
const DEFAULT_SAMPLING_INTERVAL = 32_768;

const PROFILE_CASES: readonly ProfileCase[] = Object.freeze([
    Object.freeze({
        name: 'modern-book-98',
        version: '1.21.11',
        item: 'book',
        material: 'book',
        xp: 30,
        targetClassifiedMass: 0.98
    }),
    Object.freeze({
        name: 'modern-book-995',
        version: '1.21.11',
        item: 'book',
        material: 'book',
        xp: 30,
        targetClassifiedMass: 0.995
    }),
    Object.freeze({
        name: 'modern-sword-995',
        version: '1.21.11',
        item: 'sword',
        material: 'diamond',
        xp: 30,
        targetClassifiedMass: 0.995
    }),
    Object.freeze({
        name: 'modern-book-sharpness-995',
        version: '1.21.11',
        item: 'book',
        material: 'book',
        xp: 30,
        targetClassifiedMass: 0.995,
        clue: 'Sharpness III'
    }),
    Object.freeze({
        name: 'modern-mace-xp1-exhaustive',
        version: '1.21.11',
        item: 'mace',
        material: 'mace',
        xp: 1,
        exhaustive: true
    })
]);

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const cases = options.caseName === undefined
        ? PROFILE_CASES
        : PROFILE_CASES.filter(testCase => testCase.name === options.caseName);
    if (cases.length === 0) throw new Error(`Unknown allocation profile case "${String(options.caseName)}".`);

    await fs.mkdir(options.outDir, { recursive: true });

    const summaries: RunSummary[] = [];
    for (const testCase of cases) {
        console.log(`\nCASE ${testCase.name}`);
        for (const backend of ['concrete', 'flex'] as const) {
            const summary = await profileRun(testCase, backend, options);
            summaries.push(summary);
            console.log(formatRun(summary));
        }
    }

    const summaryPath = path.join(options.outDir, 'latest.json');
    await fs.writeFile(summaryPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        samplingInterval: options.samplingInterval,
        runs: summaries
    }, jsonReplacer, 2));
    console.log(`\nWrote allocation summary: ${summaryPath}`);
}

function parseArgs(args: readonly string[]): CliOptions {
    let outDir = DEFAULT_OUT_DIR;
    let caseName: string | undefined;
    let samplingInterval = DEFAULT_SAMPLING_INTERVAL;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        const next = () => {
            const value = args[++index];
            if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
            return value;
        };

        switch (arg) {
            case '--out':
                outDir = next();
                break;
            case '--case':
                caseName = next();
                break;
            case '--sampling-interval':
                samplingInterval = parsePositiveInteger(next(), arg);
                break;
            case '--help':
            case '-h':
                printUsage();
                process.exit(0);
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }

    return { outDir, caseName, samplingInterval };
}

function printUsage(): void {
    console.log([
        'Usage: node --import tsx scripts/profile_flex_allocations.ts [options]',
        '',
        'Profiles concrete V7 and native Flex with both V8 CPU profiling and',
        'heap allocation sampling. Raw profiles and latest.json are written to tmp/.',
        '',
        'Options:',
        `  --out DIR                    Default: ${DEFAULT_OUT_DIR}`,
        '  --case NAME                  Run one built-in case',
        `  --sampling-interval BYTES    Default: ${String(DEFAULT_SAMPLING_INTERVAL)}`
    ].join('\n'));
}

async function profileRun(testCase: ProfileCase, backend: Backend, options: CliOptions): Promise<RunSummary> {
    const session = new inspector.Session();
    session.connect();

    try {
        await postInspector(session, 'Profiler.enable');
        await postInspector(session, 'HeapProfiler.enable');
        await postInspector(session, 'Profiler.start');
        await postInspector(session, 'HeapProfiler.startSampling', {
            samplingInterval: options.samplingInterval,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true
        });

        const run = runSearch(testCase, backend);
        const heap = await postInspector<{ profile: HeapProfile }>(session, 'HeapProfiler.stopSampling');
        const cpu = await postInspector<{ profile: CpuProfile }>(session, 'Profiler.stop');

        const slug = `${testCase.name}-${backend}`;
        const heapProfilePath = path.join(options.outDir, `${slug}.heapprofile.json`);
        const cpuProfilePath = path.join(options.outDir, `${slug}.cpuprofile`);
        await fs.writeFile(heapProfilePath, JSON.stringify(heap.profile));
        await fs.writeFile(cpuProfilePath, JSON.stringify(cpu.profile));

        const heapSummary = summarizeHeapProfile(heap.profile);
        const cpuSummary = summarizeCpuProfile(cpu.profile);
        return {
            backend,
            caseName: testCase.name,
            ...run,
            heapProfilePath,
            cpuProfilePath,
            sampledAllocationBytes: heapSummary.totalBytes,
            allocationBytesPerIteration: heapSummary.totalBytes / Math.max(1, run.iterations),
            gcMs: cpuSummary.gcMs,
            gcShare: cpuSummary.gcShare,
            cpuPhases: cpuSummary.phases,
            topAllocators: heapSummary.topAllocators
        };
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

function runSearch(testCase: ProfileCase, backend: Backend): CapturedRun {
    const registry = RegistryFactory.build(testCase.version);
    const kernel = new RegistryKernel({ registry, item: testCase.item, material: testCase.material });
    const targetClueId = testCase.clue === undefined
        ? undefined
        : ClueValidator.validate(registry, testCase.item, testCase.clue);
    const request = testCase.exhaustive
        ? { exhaustive: true as const }
        : {
            targetClassifiedMass: testCase.targetClassifiedMass ?? 0.995,
            probabilityFloor: 0n
        };

    const started = performance.now();
    if (backend === 'flex') {
        const run = new GroupedFlexSearchRun(kernel, { targetClueId });
        run.seedXp(testCase.xp);
        const state = run.searchToCheckpointState(request);
        const checkpoint = run.buildEngineSnapshot(state);
        const ms = performance.now() - started;
        return {
            ms,
            iterations: state.iterations,
            resultsSize: checkpoint.snapshot.results.size,
            pendingEntries: checkpoint.snapshot.pendingCount,
            pendingMass: checkpoint.snapshot.mass.pending,
            activeResidueCount: state.activeResidueCount,
            activeResidueMass: state.activeResidueMass.toString(),
            flexMemory: run.getMemoryStats()
        };
    }

    const run = new SearchRun(kernel, { targetClueId });
    run.seedXp(testCase.xp);
    const snapshot = run.searchToCheckpoint(request);
    const ms = performance.now() - started;
    return {
        ms,
        iterations: snapshot.iterations,
        resultsSize: snapshot.results.size,
        pendingEntries: snapshot.pendingEntries.length,
        pendingMass: snapshot.mass.pending,
        activeResidueCount: snapshot.activeResidueCount,
        activeResidueMass: snapshot.activeResidueMass.toString()
    };
}

function summarizeHeapProfile(profile: HeapProfile): {
    readonly totalBytes: number;
    readonly topAllocators: readonly AllocationSummary[];
} {
    const allocations = new Map<string, number>();
    let totalBytes = 0;

    const visit = (node: HeapProfileNode): void => {
        const bytes = node.selfSize ?? 0;
        totalBytes += bytes;
        const frame = formatFrame(node.callFrame?.functionName, node.callFrame?.url);
        allocations.set(frame, (allocations.get(frame) ?? 0) + bytes);
        for (const child of node.children ?? []) visit(child);
    };
    visit(profile.head);

    return {
        totalBytes,
        topAllocators: [...allocations.entries()]
            .sort((left, right) => right[1] - left[1])
            .slice(0, 12)
            .map(([frame, bytes]) => ({
                frame,
                bytes,
                share: totalBytes === 0 ? 0 : bytes / totalBytes
            }))
    };
}

function summarizeCpuProfile(profile: CpuProfile): {
    readonly gcMs: number;
    readonly gcShare: number;
    readonly phases: Record<string, PhaseSummary>;
} {
    const nodes = new Map<number, CpuNode>(profile.nodes.map(node => [node.id, node]));
    const parents = new Map<number, number>();
    for (const node of profile.nodes) {
        for (const child of node.children ?? []) parents.set(child, node.id);
    }

    const phaseMicros = new Map<string, number>();
    let totalMicros = 0;
    let gcMicros = 0;
    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    for (let index = 0; index < samples.length; index++) {
        const node = nodes.get(samples[index]!);
        if (!node) continue;
        const micros = deltas[index] ?? 0;
        totalMicros += micros;
        const stack = collectStack(node, nodes, parents);
        const phase = classifyCpuPhase(stack);
        phaseMicros.set(phase, (phaseMicros.get(phase) ?? 0) + micros);
        if (phase === 'runtime/gc') gcMicros += micros;
    }

    return {
        gcMs: gcMicros / 1000,
        gcShare: totalMicros === 0 ? 0 : gcMicros / totalMicros,
        phases: Object.fromEntries([...phaseMicros.entries()]
            .sort((left, right) => right[1] - left[1])
            .map(([phase, micros]) => [phase, {
                ms: micros / 1000,
                share: totalMicros === 0 ? 0 : micros / totalMicros
            }]))
    };
}

function collectStack(
    node: CpuNode,
    nodes: ReadonlyMap<number, CpuNode>,
    parents: ReadonlyMap<number, number>
): readonly CpuNode[] {
    const stack: CpuNode[] = [];
    let current: CpuNode | undefined = node;
    while (current) {
        stack.push(current);
        const parentId = parents.get(current.id);
        current = parentId === undefined ? undefined : nodes.get(parentId);
    }
    return stack;
}

function classifyCpuPhase(stack: readonly CpuNode[]): string {
    if (stack[0]?.callFrame.functionName === '(garbage collector)') return 'runtime/gc';
    if (stack.some(frame => frame.callFrame.url.includes('/search/flex/FlexProjector.ts'))) return 'flex/projection';
    if (stack.some(frame => frame.callFrame.url.includes('/search/flex/GroupedFlexGraph.ts'))) return 'flex/graph';
    if (stack.some(frame => frame.callFrame.url.includes('/search/flex/FlexProgramStore.ts'))) return 'flex/program-store';
    if (stack.some(frame => frame.callFrame.url.includes('/search/flex/FlexCoordinator.ts'))) return 'flex/coordinator';
    if (stack.some(frame => frame.callFrame.url.includes('/search/SearchRun.ts'))) return 'concrete/search';
    if (stack.some(frame => frame.callFrame.url.includes('/search/SearchGraph.ts'))) return 'concrete/graph';
    return 'runtime/other';
}

function formatRun(summary: RunSummary): string {
    const allocationMiB = summary.sampledAllocationBytes / 1024 / 1024;
    const perIterationKiB = summary.allocationBytesPerIteration / 1024;
    const flex = summary.flexMemory
        ? ` programs=${summary.flexMemory.programs.programCount} graphNodes=${sum(summary.flexMemory.graphs.map(graph => graph.nodeCount))} expansionBuilds=${sum(summary.flexMemory.graphs.map(graph => graph.searchExpansionCount))} residueArrays=${summary.flexMemory.coordinator.residueArrayAllocationCount} frontierGrows=${summary.flexMemory.coordinator.frontierGrowCount}/${summary.flexMemory.coordinator.frontierIndexGrowCount}`
        : '';
    return [
        `${summary.backend}: ${Math.round(summary.ms)}ms`,
        `iters=${summary.iterations}`,
        `alloc=${allocationMiB.toFixed(1)}MiB`,
        `alloc/iter=${perIterationKiB.toFixed(1)}KiB`,
        `gc=${(summary.gcShare * 100).toFixed(1)}%`,
        `results=${summary.resultsSize}`,
        `pending=${summary.pendingEntries}`,
        flex
    ].filter(Boolean).join(' ');
}

function formatFrame(functionName: string | undefined, url: string | undefined): string {
    const shortUrl = (url ?? '').replace(/^file:\/\/\/.*?mc-enchanting-analyzer\//, '');
    return `${functionName || '(anonymous)'} - ${shortUrl}`;
}

function parsePositiveInteger(value: string, label: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer, got ${value}.`);
    return parsed;
}

function sum(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

function jsonReplacer(_key: string, value: unknown): unknown {
    return typeof value === 'bigint' ? value.toString() : value;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
