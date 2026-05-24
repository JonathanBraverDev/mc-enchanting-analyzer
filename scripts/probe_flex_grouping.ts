import { performance } from 'node:perf_hooks';
import { ClueValidator } from '#core/clue.js';
import { RegistryFactory, RegistryKernel } from '#lib/index.js';
import { GroupedFlexSearchRun, type FlexRunMemoryStats } from '#lib/search/flex/index.js';

interface CliOptions {
    readonly version: string;
    readonly item: string;
    readonly material: string;
    readonly xp: number;
    readonly targetClassifiedMass: number;
    readonly exhaustive: boolean;
    readonly clue?: string | undefined;
}

interface SummedFlexGroupingStats {
    readonly programCount: number;
    readonly cachedProgramCount: number;
    readonly graphCount: number;
    readonly graphNodeCount: number;
    readonly searchExpansionCount: number;
    readonly shapeCacheHitCount: number;
    readonly shapeCacheMissCount: number;
    readonly directExpansionBuildCount: number;
    readonly shapedExpansionBuildCount: number;
    readonly groupingBuildCount: number;
    readonly groupedEdgeCount: number;
    readonly groupedAlternativeCount: number;
    readonly singletonGroupCount: number;
    readonly choiceGroupCount: number;
    readonly nodeCreateCount: number;
    readonly nodeReuseCount: number;
    readonly preparedFixedEmissionCount: number;
    readonly preparedChoiceEmissionCount: number;
    readonly preparedChoiceAlternativeCount: number;
    readonly shapePreparedEmissionAppendCount: number;
    readonly nodeIndexGrowCount: number;
    readonly residueArrayAllocationCount: number;
}

const DEFAULT_OPTIONS: CliOptions = {
    version: '1.21.11',
    item: 'book',
    material: 'book',
    xp: 30,
    targetClassifiedMass: 0.995,
    exhaustive: false
};

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const registry = RegistryFactory.build(options.version);
    const kernel = new RegistryKernel({ registry, item: options.item, material: options.material });
    const targetClueId = options.clue === undefined
        ? undefined
        : ClueValidator.validate(registry, options.item, options.clue);

    const run = new GroupedFlexSearchRun(kernel, { targetClueId });
    run.seedXp(options.xp);

    const searchStarted = performance.now();
    const state = run.searchToCheckpointState(options.exhaustive
        ? { exhaustive: true }
        : { targetClassifiedMass: options.targetClassifiedMass, probabilityFloor: 0n });
    const searchMs = performance.now() - searchStarted;
    const beforeSnapshot = sumStats(run.getMemoryStats());

    const snapshotStarted = performance.now();
    const checkpoint = run.buildEngineSnapshot(state);
    const snapshotMs = performance.now() - snapshotStarted;
    const afterSnapshot = sumStats(run.getMemoryStats());

    const summary = {
        options,
        searchMs: Math.round(searchMs),
        snapshotMs: Math.round(snapshotMs),
        iterations: state.iterations,
        pendingCount: state.pendingCount,
        resultRows: checkpoint.snapshot.results.size,
        beforeSnapshot,
        afterSnapshot
    };

    console.log(`Flex grouping probe: ${options.version} ${options.item}/${options.material} XP ${options.xp}${options.clue ? ` clue "${options.clue}"` : ''}`);
    console.log(`search=${Math.round(searchMs)}ms snapshot=${Math.round(snapshotMs)}ms iterations=${state.iterations} pending=${state.pendingCount} results=${checkpoint.snapshot.results.size}`);
    console.table([
        printableStats('after search', beforeSnapshot),
        printableStats('after snapshot', afterSnapshot)
    ]);
    console.log(JSON.stringify(summary, null, 2));
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
                options = { ...options, xp: parsePositiveInteger(next(), arg) };
                break;
            case '--target':
            case '--target-classified-mass':
                options = { ...options, targetClassifiedMass: parseProbability(next(), arg) };
                break;
            case '--clue':
                options = { ...options, clue: next() };
                break;
            case '--exhaustive':
                options = { ...options, exhaustive: true };
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
        'Usage: node --import tsx scripts/probe_flex_grouping.ts [options]',
        '',
        'Reports Flex grouped graph rebuild/reuse counters before and after snapshot construction.',
        '',
        'Options:',
        '  --version VERSION        Default: 1.21.11',
        '  --item ITEM              Default: book',
        '  --material MATERIAL      Default: book',
        '  --xp LEVEL               Default: 30',
        '  --target VALUE           Classified-mass stop. Default: 0.995',
        '  --clue "Sharpness III"   Optional exact clue',
        '  --exhaustive             Run exhaustive search instead of mass target'
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

function sumStats(memory: FlexRunMemoryStats): SummedFlexGroupingStats {
    return {
        programCount: memory.programs.programCount,
        cachedProgramCount: memory.programs.cachedProgramCount,
        graphCount: memory.graphs.length,
        graphNodeCount: sum(memory.graphs.map(graph => graph.nodeCount)),
        searchExpansionCount: sum(memory.graphs.map(graph => graph.searchExpansionCount)),
        shapeCacheHitCount: sum(memory.graphs.map(graph => graph.shapeCacheHitCount)),
        shapeCacheMissCount: sum(memory.graphs.map(graph => graph.shapeCacheMissCount)),
        directExpansionBuildCount: sum(memory.graphs.map(graph => graph.directExpansionBuildCount)),
        shapedExpansionBuildCount: sum(memory.graphs.map(graph => graph.shapedExpansionBuildCount)),
        groupingBuildCount: sum(memory.graphs.map(graph => graph.groupingBuildCount)),
        groupedEdgeCount: sum(memory.graphs.map(graph => graph.groupedEdgeCount)),
        groupedAlternativeCount: sum(memory.graphs.map(graph => graph.groupedAlternativeCount)),
        singletonGroupCount: sum(memory.graphs.map(graph => graph.singletonGroupCount)),
        choiceGroupCount: sum(memory.graphs.map(graph => graph.choiceGroupCount)),
        nodeCreateCount: sum(memory.graphs.map(graph => graph.nodeCreateCount)),
        nodeReuseCount: sum(memory.graphs.map(graph => graph.nodeReuseCount)),
        preparedFixedEmissionCount: sum(memory.graphs.map(graph => graph.preparedFixedEmissionCount)),
        preparedChoiceEmissionCount: sum(memory.graphs.map(graph => graph.preparedChoiceEmissionCount)),
        preparedChoiceAlternativeCount: sum(memory.graphs.map(graph => graph.preparedChoiceAlternativeCount)),
        shapePreparedEmissionAppendCount: sum(memory.graphs.map(graph => graph.shapePreparedEmissionAppendCount)),
        nodeIndexGrowCount: sum(memory.graphs.map(graph => graph.nodeIndexGrowCount)),
        residueArrayAllocationCount: memory.coordinator.residueArrayAllocationCount
    };
}

function printableStats(phase: string, stats: SummedFlexGroupingStats): Record<string, string | number> {
    return {
        phase,
        programs: stats.programCount,
        cachedPrograms: stats.cachedProgramCount,
        graphNodes: stats.graphNodeCount,
        expansions: stats.searchExpansionCount,
        groupingBuilds: stats.groupingBuildCount,
        directBuilds: stats.directExpansionBuildCount,
        shapedBuilds: stats.shapedExpansionBuildCount,
        shapeHits: stats.shapeCacheHitCount,
        shapeMisses: stats.shapeCacheMissCount,
        singletonGroups: stats.singletonGroupCount,
        choiceGroups: stats.choiceGroupCount,
        groupedEdges: stats.groupedEdgeCount,
        groupedAlternatives: stats.groupedAlternativeCount,
        preparedFixed: stats.preparedFixedEmissionCount,
        preparedChoices: stats.preparedChoiceEmissionCount,
        preparedChoiceAlts: stats.preparedChoiceAlternativeCount,
        shapeEmissionAppends: stats.shapePreparedEmissionAppendCount,
        nodeCreates: stats.nodeCreateCount,
        nodeReuses: stats.nodeReuseCount,
        reuseRate: formatRatio(stats.nodeReuseCount, stats.nodeCreateCount + stats.nodeReuseCount),
        groupingsPerExpansion: formatRatio(stats.groupingBuildCount, stats.searchExpansionCount),
        choicesPreparedPerChoiceGroup: formatRatio(stats.preparedChoiceEmissionCount, stats.choiceGroupCount),
        residueArrays: stats.residueArrayAllocationCount,
        nodeIndexGrows: stats.nodeIndexGrowCount
    };
}

function sum(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

function formatRatio(numerator: number, denominator: number): string {
    if (denominator === 0) return '0.000';
    return (numerator / denominator).toFixed(3);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
