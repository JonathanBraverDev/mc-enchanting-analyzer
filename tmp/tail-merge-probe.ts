import { performance } from 'node:perf_hooks';
import { RegistryFactory } from '#core/factory.js';
import { RegistryKernel } from '#lib/search/index.js';
import { GroupedFlexSearchRun, type FlexNodeId } from '#lib/search/flex/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';

interface CaseSpec {
    readonly label: string;
    readonly version: string;
    readonly item: string;
    readonly material: string;
    readonly xp: number;
    readonly targetClassifiedMass: number;
}

interface GraphLike {
    exclusionMasks: bigint[];
    currentLevels: number[];
    counts: number[];
    withSearchExpansion<T>(nodeId: FlexNodeId, consumer: (expansion: unknown) => T): T;
}

interface GraphRecordLike {
    graph: GraphLike;
}

const CASES: readonly CaseSpec[] = [
    { label: 'modern book 99.5%', version: '1.21.11', item: 'book', material: 'book', xp: 30, targetClassifiedMass: 0.995 },
    { label: 'modern book 99.95%', version: '1.21.11', item: 'book', material: 'book', xp: 30, targetClassifiedMass: 0.9995 },
    { label: 'modern sword 99.5%', version: '1.21.11', item: 'sword', material: 'diamond', xp: 30, targetClassifiedMass: 0.995 },
    { label: '1.14 chestplate 99.5%', version: '1.14', item: 'chestplate', material: 'diamond', xp: 30, targetClassifiedMass: 0.995 },
    { label: '1.7.2 book 99.5%', version: '1.7.2', item: 'book', material: 'book', xp: 30, targetClassifiedMass: 0.995 }
];

for (const spec of CASES) {
    const registry = RegistryFactory.build(spec.version);
    const kernel = new RegistryKernel({ registry, item: spec.item, material: spec.material });
    const run = new GroupedFlexSearchRun(kernel);
    run.seedXp(spec.xp);

    const expandedByGraph = installExpansionRecorder(run);
    const started = performance.now();
    const state = run.searchToCheckpointState({
        targetClassifiedMass: spec.targetClassifiedMass,
        probabilityFloor: 0n
    });
    const elapsedMs = performance.now() - started;
    const memory = run.getMemoryStats();
    const graphs = getGraphs(run);

    const expanded = summarizeTailShapes(graphs, expandedByGraph, true);
    const materialized = summarizeTailShapes(graphs, undefined, false);

    const summary = {
        case: spec.label,
        elapsedMs: Math.round(elapsedMs),
        iterations: state.iterations,
        pendingCount: state.pendingCount,
        graphCount: state.graphCount,
        graphNodes: sum(memory.graphs.map(graph => graph.nodeCount)),
        nodeReuseRate: ratio(
            sum(memory.graphs.map(graph => graph.nodeReuseCount)),
            sum(memory.graphs.map(graph => graph.nodeReuseCount + graph.nodeCreateCount))
        ),
        choiceGroups: sum(memory.graphs.map(graph => graph.choiceGroupCount)),
        groupedAlternatives: sum(memory.graphs.map(graph => graph.groupedAlternativeCount)),
        expanded,
        materialized
    };

    console.log(JSON.stringify(summary, null, 2));
}

function installExpansionRecorder(run: GroupedFlexSearchRun): Map<number, Set<number>> {
    const expandedByGraph = new Map<number, Set<number>>();
    const graphs = getGraphs(run);

    graphs.forEach((record, graphId) => {
        const graph = record.graph;
        const original = graph.withSearchExpansion.bind(graph);
        graph.withSearchExpansion = ((nodeId: FlexNodeId, consumer: (expansion: unknown) => unknown) => {
            let expanded = expandedByGraph.get(graphId);
            if (!expanded) {
                expanded = new Set<number>();
                expandedByGraph.set(graphId, expanded);
            }
            expanded.add(nodeId as number);
            return original(nodeId, consumer);
        }) as GraphLike['withSearchExpansion'];
    });

    return expandedByGraph;
}

function getGraphs(run: GroupedFlexSearchRun): GraphRecordLike[] {
    return (run as unknown as { graphs: GraphLike[] }).graphs.map(graph => ({ graph }));
}

function summarizeTailShapes(
    graphs: readonly GraphRecordLike[],
    expandedByGraph: ReadonlyMap<number, ReadonlySet<number>> | undefined,
    expandedOnly: boolean
): Record<string, unknown> {
    let eligibleNodes = 0;
    let duplicateShapeNodes = 0;
    let duplicateStrictTailNodes = 0;
    let duplicateLooseTailNodes = 0;
    let shapeGroupCount = 0;
    let strictTailGroupCount = 0;
    let looseTailGroupCount = 0;
    let largestShapeGroup = 0;
    let largestStrictTailGroup = 0;
    let largestLooseTailGroup = 0;

    for (let graphId = 0; graphId < graphs.length; graphId++) {
        const graph = graphs[graphId]!.graph;
        const nodeIds = expandedOnly
            ? [...(expandedByGraph?.get(graphId) ?? [])]
            : graph.counts.map((_, nodeId) => nodeId);

        const byShape = new Map<string, number>();
        const byStrictTail = new Map<string, number>();
        const byLooseTail = new Map<string, number>();

        for (const nodeId of nodeIds) {
            const count = graph.counts[nodeId]!;
            if (count === 0 || count >= ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM) continue;
            const exclusionMask = graph.exclusionMasks[nodeId]!;
            const currentLevel = graph.currentLevels[nodeId]!;
            eligibleNodes++;

            add(byShape, exclusionMask.toString(16));
            add(byStrictTail, `${exclusionMask.toString(16)}|${count}|${continueTail(currentLevel, true)}`);
            add(byLooseTail, `${exclusionMask.toString(16)}|${continueTail(currentLevel, true)}`);
        }

        const shape = summarizeGroups(byShape);
        const strictTail = summarizeGroups(byStrictTail);
        const looseTail = summarizeGroups(byLooseTail);
        duplicateShapeNodes += shape.duplicateNodes;
        duplicateStrictTailNodes += strictTail.duplicateNodes;
        duplicateLooseTailNodes += looseTail.duplicateNodes;
        shapeGroupCount += shape.groupCount;
        strictTailGroupCount += strictTail.groupCount;
        looseTailGroupCount += looseTail.groupCount;
        largestShapeGroup = Math.max(largestShapeGroup, shape.largestGroup);
        largestStrictTailGroup = Math.max(largestStrictTailGroup, strictTail.largestGroup);
        largestLooseTailGroup = Math.max(largestLooseTailGroup, looseTail.largestGroup);
    }

    return {
        eligibleNodes,
        shapeGroupCount,
        duplicateShapeNodes,
        duplicateShapeRate: ratio(duplicateShapeNodes, eligibleNodes),
        largestShapeGroup,
        strictTailGroupCount,
        duplicateStrictTailNodes,
        duplicateStrictTailRate: ratio(duplicateStrictTailNodes, eligibleNodes),
        largestStrictTailGroup,
        looseTailGroupCount,
        duplicateLooseTailNodes,
        duplicateLooseTailRate: ratio(duplicateLooseTailNodes, eligibleNodes),
        largestLooseTailGroup
    };
}

function add(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function summarizeGroups(groups: ReadonlyMap<string, number>): {
    readonly groupCount: number;
    readonly duplicateNodes: number;
    readonly largestGroup: number;
} {
    let duplicateNodes = 0;
    let largestGroup = 0;
    for (const count of groups.values()) {
        if (count > 1) duplicateNodes += count - 1;
        largestGroup = Math.max(largestGroup, count);
    }
    return { groupCount: groups.size, duplicateNodes, largestGroup };
}

function continueTail(level: number, afterCurrentPick: boolean): string {
    const levels: number[] = [];
    let current = afterCurrentPick ? Math.floor(level / 2) : level;
    while (current > 0) {
        levels.push(current);
        const next = Math.floor(current / 2);
        if (next === current) break;
        current = next;
    }
    return levels.join(',');
}

function sum(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): string {
    if (denominator === 0) return '0.000';
    return (numerator / denominator).toFixed(3);
}
