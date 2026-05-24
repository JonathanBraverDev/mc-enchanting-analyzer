import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ClueValidator } from '#core/clue.js';
import { RegistryFactory } from '#core/factory.js';
import { RegistryKernel } from '#lib/search/index.js';
import { SearchRun } from '#lib/search/SearchRun.js';
import {
    GroupedFlexSearchRun,
    type FlexNodeId,
    type FlexProgramId,
    type FlexRunMemoryStats
} from '#lib/search/flex/index.js';

type Backend = 'concrete' | 'flex';

interface TreeStatsCase {
    readonly name: string;
    readonly version: string;
    readonly item: string;
    readonly material: string;
    readonly xp: number;
    readonly exhaustive?: boolean | undefined;
    readonly targetClassifiedMass?: number | undefined;
    readonly clue?: string | undefined;
}

interface CliOptions {
    readonly outDir: string;
    readonly caseNames: readonly string[];
    readonly list: boolean;
}

interface BackendTreeStats {
    readonly backend: Backend;
    readonly caseName: string;
    readonly ms: number;
    readonly iterations: number;
    readonly iterationsPerSec: number;
    readonly graphNodeCount: number;
    readonly graphNodesPerSec: number;
    readonly graphExpansionCount: number;
    readonly graphExpansionsPerSec: number;
    readonly resultComboRows: number;
    readonly resultCombosPerSec: number;
    readonly resultCombosPerIteration: number;
    readonly sourceResultPrograms?: number | undefined;
    readonly sourceProgramsPerSec?: number | undefined;
    readonly pendingEntries: number;
    readonly pendingMass: string;
    readonly largestPendingMass: string;
    readonly activeResidueCount: number;
    readonly activeResidueMass: string;
    readonly graphCount: number;
    readonly programCount?: number | undefined;
    readonly cachedProgramCount?: number | undefined;
    readonly frontierGrowCount?: number | undefined;
    readonly frontierIndexGrowCount?: number | undefined;
    readonly residueRecordCount?: number | undefined;
    readonly residueArrayAllocationCount?: number | undefined;
    readonly groupedEdgeCount?: number | undefined;
    readonly groupedAlternativeCount?: number | undefined;
    readonly groupingBuildCount?: number | undefined;
    readonly shapeCacheHitCount?: number | undefined;
    readonly shapeCacheMissCount?: number | undefined;
    readonly lazyChoiceEmissionMemberVisitCount?: number | undefined;
    readonly nodeCreateCount?: number | undefined;
    readonly nodeReuseCount?: number | undefined;
    readonly blueprintHits?: number | undefined;
    readonly blueprintMisses?: number | undefined;
    readonly savedCandidateChecks?: number | undefined;
    readonly exitReason: string;
    readonly flexStructuralSolidNodes?: number | undefined;
    readonly flexStructuralPlexNodes?: number | undefined;
    readonly flexExpandedSolidIterations?: number | undefined;
    readonly flexExpandedPlexIterations?: number | undefined;
    readonly flexPendingSolidEntries?: number | undefined;
    readonly flexPendingPlexEntries?: number | undefined;
    readonly flexPendingSolidMass?: string | undefined;
    readonly flexPendingPlexMass?: string | undefined;
    readonly flexSourceSolidPrograms?: number | undefined;
    readonly flexSourcePlexPrograms?: number | undefined;
    readonly flexSourceUnknownPrograms?: number | undefined;
    readonly flexSourceSolidMass?: string | undefined;
    readonly flexSourcePlexMass?: string | undefined;
    readonly flexSourceUnknownMass?: string | undefined;
}

interface ComparisonSummary {
    readonly caseName: string;
    readonly concreteMs: number;
    readonly flexMs: number;
    readonly flexTimeRatio: number;
    readonly concreteIterations: number;
    readonly flexIterations: number;
    readonly flexIterationRatio: number;
    readonly concreteGraphNodes: number;
    readonly flexGraphNodes: number;
    readonly flexGraphNodeRatio: number;
    readonly concreteIterationsPerSec: number;
    readonly flexIterationsPerSec: number;
    readonly concreteResultCombosPerSec: number;
    readonly flexResultCombosPerSec: number;
    readonly flexResultCombosPerSecRatio: number;
    readonly flexSolidPlexNodes: string;
    readonly flexSolidPlexExpanded: string;
    readonly flexSolidPlexPending: string;
    readonly flexSolidPlexSourcePrograms: string;
}

const DEFAULT_OUT_DIR = 'tmp/flex-tree-stats';

const CASES: readonly TreeStatsCase[] = Object.freeze([
    Object.freeze({
        name: 'modern-mace-xp1-exhaustive',
        version: '1.21.11',
        item: 'mace',
        material: 'mace',
        xp: 1,
        exhaustive: true
    }),
    Object.freeze({
        name: 'modern-sword-xp30-exhaustive',
        version: '1.21.11',
        item: 'sword',
        material: 'diamond',
        xp: 30,
        exhaustive: true
    }),
    Object.freeze({
        name: 'modern-bow-xp30-exhaustive',
        version: '1.21.11',
        item: 'bow',
        material: 'bow',
        xp: 30,
        exhaustive: true
    }),
    Object.freeze({
        name: 'modern-pickaxe-xp30-exhaustive',
        version: '1.21.11',
        item: 'pickaxe',
        material: 'diamond',
        xp: 30,
        exhaustive: true
    }),
    Object.freeze({
        name: 'modern-book-xp30-mass-995',
        version: '1.21.11',
        item: 'book',
        material: 'book',
        xp: 30,
        targetClassifiedMass: 0.995
    }),
    Object.freeze({
        name: 'modern-book-xp30-sharpness-mass-995',
        version: '1.21.11',
        item: 'book',
        material: 'book',
        xp: 30,
        targetClassifiedMass: 0.995,
        clue: 'Sharpness III'
    })
]);

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.list) {
        printCases();
        return;
    }

    const selectedCases = selectCases(options.caseNames);
    await fs.mkdir(options.outDir, { recursive: true });

    const runs: BackendTreeStats[] = [];
    const summaries: ComparisonSummary[] = [];

    for (const testCase of selectedCases) {
        console.log(`\nCASE ${testCase.name}`);
        const concrete = runConcrete(testCase);
        const flex = runFlex(testCase);
        runs.push(concrete, flex);
        const summary = createSummary(concrete, flex);
        summaries.push(summary);
        printPair(concrete, flex);
    }

    console.log('\nSummary');
    console.table(summaries.map(printableSummary));

    const reportPath = path.join(options.outDir, 'latest.json');
    await fs.writeFile(reportPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        notes: [
            'Profiler-free single-run comparison.',
            'iterationsPerSec is raw frontier expansion throughput.',
            'resultCombosPerSec is public result combo rows produced by the snapshot. For non-exhaustive cases this is resolved rows at the checkpoint, not the final complete search space.',
            'Flex Solid/Plex pending and source-program splits are diagnostic post-run scans and are not included in measured runtime.'
        ],
        cases: selectedCases,
        runs,
        summaries
    }, null, 2));
    console.log(`\nWrote ${reportPath}`);
}

function runConcrete(testCase: TreeStatsCase): BackendTreeStats {
    const registry = RegistryFactory.build(testCase.version);
    const kernel = new RegistryKernel({ registry, item: testCase.item, material: testCase.material });
    const targetClueId = testCase.clue === undefined
        ? undefined
        : ClueValidator.validate(registry, testCase.item, testCase.clue);
    const request = createRequest(testCase);

    const started = performance.now();
    const run = new SearchRun(kernel, { targetClueId });
    run.seedXp(testCase.xp);
    const snapshot = run.searchToCheckpoint(request);
    const ms = performance.now() - started;
    const diagnostics = run.getGraphDiagnostics(false);
    const graphNodeCount = sum(diagnostics.map(graph => graph.nodeCount));
    const graphExpansionCount = sum(diagnostics.map(graph => graph.expansionCount));

    return addRates({
        backend: 'concrete',
        caseName: testCase.name,
        ms,
        iterations: snapshot.iterations,
        graphNodeCount,
        graphExpansionCount,
        resultComboRows: snapshot.results.size,
        pendingEntries: snapshot.pendingEntries.length,
        pendingMass: String(snapshot.mass.pending),
        largestPendingMass: String(snapshot.largestPendingMass),
        activeResidueCount: snapshot.activeResidueCount,
        activeResidueMass: String(snapshot.activeResidueMass),
        graphCount: snapshot.graphCount,
        blueprintHits: sum(diagnostics.map(graph => graph.blueprints.hits)),
        blueprintMisses: sum(diagnostics.map(graph => graph.blueprints.misses)),
        savedCandidateChecks: sum(diagnostics.map(graph => graph.blueprints.savedCandidateChecks)),
        exitReason: snapshot.fullyResolved ? 'empty' : 'checkpoint'
    });
}

function runFlex(testCase: TreeStatsCase): BackendTreeStats {
    const registry = RegistryFactory.build(testCase.version);
    const kernel = new RegistryKernel({ registry, item: testCase.item, material: testCase.material });
    const targetClueId = testCase.clue === undefined
        ? undefined
        : ClueValidator.validate(registry, testCase.item, testCase.clue);
    const request = createRequest(testCase);

    const started = performance.now();
    const run = new GroupedFlexSearchRun(kernel, { targetClueId });
    run.seedXp(testCase.xp);
    const state = run.searchToCheckpointState(request);
    const checkpoint = run.buildEngineSnapshot(state);
    const ms = performance.now() - started;
    const memory = run.getMemoryStats();
    const graphNodeCount = sum(memory.graphs.map(graph => graph.nodeCount));
    const graphExpansionCount = sum(memory.graphs.map(graph => graph.searchExpansionCount));
    const sourceResultPrograms = state.results.size;
    const pendingStats = collectPendingKindStats(run.snapshot().pendingEntries);
    const sourceStats = collectFlexSourceProgramKindStats(run, memory, state.results);

    return addRates({
        backend: 'flex',
        caseName: testCase.name,
        ms,
        iterations: state.iterations,
        graphNodeCount,
        graphExpansionCount,
        resultComboRows: checkpoint.snapshot.results.size,
        sourceResultPrograms,
        sourceProgramsPerSec: perSec(sourceResultPrograms, ms),
        pendingEntries: checkpoint.snapshot.pendingCount,
        pendingMass: String(checkpoint.snapshot.mass.pending),
        largestPendingMass: String(checkpoint.snapshot.largestPendingMass),
        activeResidueCount: state.activeResidueCount,
        activeResidueMass: String(state.activeResidueMass),
        graphCount: state.graphCount,
        programCount: memory.programs.programCount,
        cachedProgramCount: memory.programs.cachedProgramCount,
        frontierGrowCount: memory.coordinator.frontierGrowCount,
        frontierIndexGrowCount: memory.coordinator.frontierIndexGrowCount,
        residueRecordCount: memory.coordinator.activeResidueRecordCount,
        residueArrayAllocationCount: memory.coordinator.residueArrayAllocationCount,
        groupedEdgeCount: sum(memory.graphs.map(graph => graph.groupedEdgeCount)),
        groupedAlternativeCount: sum(memory.graphs.map(graph => graph.groupedAlternativeCount)),
        groupingBuildCount: sum(memory.graphs.map(graph => graph.groupingBuildCount)),
        shapeCacheHitCount: sum(memory.graphs.map(graph => graph.shapeCacheHitCount)),
        shapeCacheMissCount: sum(memory.graphs.map(graph => graph.shapeCacheMissCount)),
        lazyChoiceEmissionMemberVisitCount: sum(memory.graphs.map(graph => graph.lazyChoiceEmissionMemberVisitCount)),
        nodeCreateCount: sum(memory.graphs.map(graph => graph.nodeCreateCount)),
        nodeReuseCount: sum(memory.graphs.map(graph => graph.nodeReuseCount)),
        exitReason: state.exitReason ?? 'unknown',
        flexStructuralSolidNodes: sum(memory.graphs.map(graph => graph.solidNodeCount)),
        flexStructuralPlexNodes: sum(memory.graphs.map(graph => graph.plexNodeCount)),
        flexExpandedSolidIterations: memory.coordinator.expandedSolidNodeCount,
        flexExpandedPlexIterations: memory.coordinator.expandedPlexNodeCount,
        flexPendingSolidEntries: pendingStats.solidEntries,
        flexPendingPlexEntries: pendingStats.plexEntries,
        flexPendingSolidMass: String(pendingStats.solidMass),
        flexPendingPlexMass: String(pendingStats.plexMass),
        flexSourceSolidPrograms: sourceStats.solidPrograms,
        flexSourcePlexPrograms: sourceStats.plexPrograms,
        flexSourceUnknownPrograms: sourceStats.unknownPrograms,
        flexSourceSolidMass: String(sourceStats.solidMass),
        flexSourcePlexMass: String(sourceStats.plexMass),
        flexSourceUnknownMass: String(sourceStats.unknownMass)
    });
}

function collectFlexSourceProgramKindStats(
    run: GroupedFlexSearchRun,
    memory: FlexRunMemoryStats,
    results: ReadonlyMap<FlexProgramId, bigint>
): {
    readonly solidPrograms: number;
    readonly plexPrograms: number;
    readonly unknownPrograms: number;
    readonly solidMass: bigint;
    readonly plexMass: bigint;
    readonly unknownMass: bigint;
} {
    const programKinds = new Map<FlexProgramId, 'solid' | 'plex'>();
    for (let graphId = 0; graphId < memory.graphs.length; graphId++) {
        const graph = run.getGraph(graphId);
        const nodeCount = memory.graphs[graphId]!.nodeCount;
        for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
            const nodeId = nodeIndex as FlexNodeId;
            programKinds.set(graph.getProgramId(nodeId), graph.getNodeKind(nodeId));
        }
    }

    let solidPrograms = 0;
    let plexPrograms = 0;
    let unknownPrograms = 0;
    let solidMass = 0n;
    let plexMass = 0n;
    let unknownMass = 0n;
    for (const [programId, mass] of results) {
        const kind = programKinds.get(programId);
        if (kind === 'solid') {
            solidPrograms++;
            solidMass += mass;
        } else if (kind === 'plex') {
            plexPrograms++;
            plexMass += mass;
        } else {
            unknownPrograms++;
            unknownMass += mass;
        }
    }

    return { solidPrograms, plexPrograms, unknownPrograms, solidMass, plexMass, unknownMass };
}

function collectPendingKindStats(entries: readonly {
    readonly nodeKind: 'solid' | 'plex';
    readonly mass: bigint;
}[]): {
    readonly solidEntries: number;
    readonly plexEntries: number;
    readonly solidMass: bigint;
    readonly plexMass: bigint;
} {
    let solidEntries = 0;
    let plexEntries = 0;
    let solidMass = 0n;
    let plexMass = 0n;
    for (const entry of entries) {
        if (entry.nodeKind === 'solid') {
            solidEntries++;
            solidMass += entry.mass;
        } else {
            plexEntries++;
            plexMass += entry.mass;
        }
    }
    return { solidEntries, plexEntries, solidMass, plexMass };
}

function createRequest(testCase: TreeStatsCase): {
    readonly exhaustive?: true;
    readonly targetClassifiedMass?: number;
    readonly probabilityFloor?: bigint;
} {
    if (testCase.exhaustive) return { exhaustive: true };
    return {
        targetClassifiedMass: testCase.targetClassifiedMass ?? 0.995,
        probabilityFloor: 0n
    };
}

function addRates(run: Omit<BackendTreeStats,
    'iterationsPerSec'
    | 'graphNodesPerSec'
    | 'graphExpansionsPerSec'
    | 'resultCombosPerSec'
    | 'resultCombosPerIteration'
>): BackendTreeStats {
    return {
        ...run,
        iterationsPerSec: perSec(run.iterations, run.ms),
        graphNodesPerSec: perSec(run.graphNodeCount, run.ms),
        graphExpansionsPerSec: perSec(run.graphExpansionCount, run.ms),
        resultCombosPerSec: perSec(run.resultComboRows, run.ms),
        resultCombosPerIteration: run.iterations === 0 ? 0 : run.resultComboRows / run.iterations
    };
}

function createSummary(concrete: BackendTreeStats, flex: BackendTreeStats): ComparisonSummary {
    return {
        caseName: concrete.caseName,
        concreteMs: concrete.ms,
        flexMs: flex.ms,
        flexTimeRatio: flex.ms / concrete.ms,
        concreteIterations: concrete.iterations,
        flexIterations: flex.iterations,
        flexIterationRatio: flex.iterations / concrete.iterations,
        concreteGraphNodes: concrete.graphNodeCount,
        flexGraphNodes: flex.graphNodeCount,
        flexGraphNodeRatio: flex.graphNodeCount / concrete.graphNodeCount,
        concreteIterationsPerSec: concrete.iterationsPerSec,
        flexIterationsPerSec: flex.iterationsPerSec,
        concreteResultCombosPerSec: concrete.resultCombosPerSec,
        flexResultCombosPerSec: flex.resultCombosPerSec,
        flexResultCombosPerSecRatio: flex.resultCombosPerSec / concrete.resultCombosPerSec,
        flexSolidPlexNodes: formatSplit(flex.flexStructuralSolidNodes, flex.flexStructuralPlexNodes),
        flexSolidPlexExpanded: formatSplit(flex.flexExpandedSolidIterations, flex.flexExpandedPlexIterations),
        flexSolidPlexPending: formatSplit(flex.flexPendingSolidEntries, flex.flexPendingPlexEntries),
        flexSolidPlexSourcePrograms: formatSplit(flex.flexSourceSolidPrograms, flex.flexSourcePlexPrograms)
    };
}

function printPair(concrete: BackendTreeStats, flex: BackendTreeStats): void {
    console.table([concrete, flex].map(run => ({
        backend: run.backend,
        ms: formatNumber(run.ms),
        iterations: run.iterations,
        iter_s: formatNumber(run.iterationsPerSec),
        graphNodes: run.graphNodeCount,
        graphNodes_s: formatNumber(run.graphNodesPerSec),
        graphExpansions: run.graphExpansionCount,
        combos: run.resultComboRows,
        combos_s: formatNumber(run.resultCombosPerSec),
        combos_iter: formatNumber(run.resultCombosPerIteration),
        pending: run.pendingEntries,
        programs: run.programCount ?? '',
        sourcePrograms: run.sourceResultPrograms ?? ''
    })));
    console.log(`Flex/concrete time: ${formatRatio(flex.ms, concrete.ms)}x`);
    console.log(`Flex/concrete iterations: ${formatRatio(flex.iterations, concrete.iterations)}x`);
    console.log(`Flex/concrete graph nodes: ${formatRatio(flex.graphNodeCount, concrete.graphNodeCount)}x`);
    console.log(`Flex/concrete combos/sec: ${formatRatio(flex.resultCombosPerSec, concrete.resultCombosPerSec)}x`);
    console.log('Flex Solid/Plex split:', {
        structuralNodes: `${flex.flexStructuralSolidNodes ?? 0} solid / ${flex.flexStructuralPlexNodes ?? 0} plex`,
        expandedIterations: `${flex.flexExpandedSolidIterations ?? 0} solid / ${flex.flexExpandedPlexIterations ?? 0} plex`,
        pendingEntries: `${flex.flexPendingSolidEntries ?? 0} solid / ${flex.flexPendingPlexEntries ?? 0} plex`,
        sourcePrograms: `${flex.flexSourceSolidPrograms ?? 0} solid / ${flex.flexSourcePlexPrograms ?? 0} plex`
    });
}

function printableSummary(summary: ComparisonSummary): Record<string, string | number> {
    return {
        case: summary.caseName,
        v7Ms: Math.round(summary.concreteMs),
        flexMs: Math.round(summary.flexMs),
        flexTime: `${summary.flexTimeRatio.toFixed(2)}x`,
        v7Iterations: summary.concreteIterations,
        flexIterations: summary.flexIterations,
        flexIterationsVsV7: `${summary.flexIterationRatio.toFixed(2)}x`,
        v7Nodes: summary.concreteGraphNodes,
        flexNodes: summary.flexGraphNodes,
        flexNodesVsV7: `${summary.flexGraphNodeRatio.toFixed(2)}x`,
        v7IterS: Math.round(summary.concreteIterationsPerSec),
        flexIterS: Math.round(summary.flexIterationsPerSec),
        v7CombosS: Math.round(summary.concreteResultCombosPerSec),
        flexCombosS: Math.round(summary.flexResultCombosPerSec),
        flexCombosSVsV7: `${summary.flexResultCombosPerSecRatio.toFixed(2)}x`,
        flexNodesSolidPlex: summary.flexSolidPlexNodes,
        flexExpandedSolidPlex: summary.flexSolidPlexExpanded
    };
}

function selectCases(caseNames: readonly string[]): readonly TreeStatsCase[] {
    if (caseNames.length === 0) return CASES;
    const selected: TreeStatsCase[] = [];
    for (const name of caseNames) {
        const testCase = CASES.find(candidate => candidate.name === name);
        if (!testCase) throw new Error(`Unknown case "${name}". Run with --list to see available cases.`);
        selected.push(testCase);
    }
    return selected;
}

function parseArgs(args: readonly string[]): CliOptions {
    let outDir = DEFAULT_OUT_DIR;
    const caseNames: string[] = [];
    let list = false;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        const next = (): string => {
            const value = args[++index];
            if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
            return value;
        };

        if (arg === '--case') {
            caseNames.push(next());
        } else if (arg === '--out') {
            outDir = next();
        } else if (arg === '--list') {
            list = true;
        } else if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        } else {
            throw new Error(`Unknown argument "${arg}". Run with --help for usage.`);
        }
    }

    return { outDir, caseNames, list };
}

function printUsage(): void {
    console.log([
        'Usage: node --import tsx scripts/compare_flex_tree_stats.ts [options]',
        '',
        'Runs paired concrete V7 vs Flex tree/throughput diagnostics and writes latest.json.',
        '',
        'Options:',
        `  --out DIR       Output directory. Default: ${DEFAULT_OUT_DIR}`,
        '  --case NAME     Run only this case. Can be passed multiple times.',
        '  --list          Print case names and exit.',
        '  --help          Print this message.'
    ].join('\n'));
}

function printCases(): void {
    console.table(CASES.map(testCase => ({
        name: testCase.name,
        version: testCase.version,
        item: testCase.item,
        material: testCase.material,
        xp: testCase.xp,
        mode: testCase.exhaustive
            ? 'exhaustive'
            : `mass ${testCase.targetClassifiedMass ?? 0.995}`,
        clue: testCase.clue ?? ''
    })));
}

function perSec(count: number, ms: number): number {
    return ms === 0 ? 0 : count / (ms / 1000);
}

function sum(values: readonly number[]): number {
    let total = 0;
    for (const value of values) total += value;
    return total;
}

function formatRatio(numerator: number, denominator: number): string {
    if (denominator === 0) return '0.000';
    return (numerator / denominator).toFixed(3);
}

function formatSplit(left: number | undefined, right: number | undefined): string {
    return `${left ?? 0}/${right ?? 0}`;
}

function formatNumber(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    if (Math.abs(value) >= 1000) return value.toFixed(0);
    if (Math.abs(value) >= 100) return value.toFixed(1);
    if (Math.abs(value) >= 10) return value.toFixed(2);
    return value.toFixed(3);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
