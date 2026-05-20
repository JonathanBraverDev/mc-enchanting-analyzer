import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    RegistryFactory,
    RegistryKernel,
    SearchGraph,
    SearchRun,
    type PackedCombo,
    type SearchGraphEdge,
    type SearchGraphNodeId
} from '#lib/index.js';
import type { SearchRunSnapshot } from '#lib/search/SearchRun.js';
import {
    FlexProgramStore,
    SolidFlexGraph,
    SolidFlexSearchRun,
    type FlexNodeId,
    type FlexProjectedPendingEntry,
    type FlexRunSnapshot
} from '#lib/search/flex/index.js';

interface ConvergentPair {
    readonly leftRootIndex: number;
    readonly rightRootIndex: number;
    readonly convergedChildId: SearchGraphNodeId;
}

describe('SolidFlexGraph', () => {
    it('maps concrete roots to the empty SolidNode program', () => {
        const { graph, solid, programs } = createSolidGraph();
        const concreteRoot = graph.getRootNode(30);
        const root = solid.getRootNode(30);

        assert.strictEqual(root.kind, 'solid');
        assert.strictEqual(root.id, concreteRoot.id as number as FlexNodeId);
        assert.strictEqual(root.programId, programs.empty);
        assert.deepStrictEqual(programs.getProgram(root.programId), []);
    });

    it('maps concrete root edges to fixed SolidNode programs', () => {
        const { graph, solid, programs } = createSolidGraph();
        const concreteRoot = graph.getRootNode(30);
        const concreteExpansion = graph.getExpansion(concreteRoot.id);
        const flexExpansion = solid.getExpansion(solid.getRootNode(30).id);

        assert.ok(concreteExpansion.edges.length > 0);
        assert.strictEqual(flexExpansion.edges.length, concreteExpansion.edges.length);

        const concreteEdge = concreteExpansion.edges[0]!;
        const flexEdge = flexExpansion.edges[0]!;
        const child = solid.getExpansion(flexEdge.childId).node;
        const program = programs.getProgram(child.programId);

        assert.strictEqual(child.kind, 'solid');
        assert.strictEqual(program.length, 1);
        assert.strictEqual(program[0]?.kind, 'fixed');
        if (program[0]?.kind === 'fixed') {
            assert.strictEqual(program[0].packedEnchant, concreteEdge.entry.packedEnchant);
        }
    });

    it('uses canonical concrete combo identity for convergent compatible selection order', () => {
        const { graph, solid } = createSolidGraph();
        const concreteRoot = graph.getRootNode(30);
        const pair = findConvergentPair(graph, concreteRoot.id);
        assert.ok(pair, 'test case should have at least one compatible convergent pair');

        const flexRootExpansion = solid.getExpansion(solid.getRootNode(30).id);
        const leftChild = flexRootExpansion.edges[pair.leftRootIndex]!.childId;
        const rightChild = flexRootExpansion.edges[pair.rightRootIndex]!.childId;
        const leftExpansion = solid.getExpansion(leftChild);
        const rightExpansion = solid.getExpansion(rightChild);
        const leftFinal = leftExpansion.edges.find(edge => edge.childId === pair.convergedChildId as number as FlexNodeId);
        const rightFinal = rightExpansion.edges.find(edge => edge.childId === pair.convergedChildId as number as FlexNodeId);

        assert.ok(leftFinal);
        assert.ok(rightFinal);
        assert.strictEqual(leftFinal.childId, rightFinal.childId);
        assert.strictEqual(solid.getProgramId(leftFinal.childId), solid.getProgramId(rightFinal.childId));
    });
});

describe('SolidFlexSearchRun', () => {
    it('matches concrete exhaustive non-book search at low XP', () => {
        const { concrete, flex, projected } = runConcreteAndFlex(1, { exhaustive: true });

        assert.strictEqual(flex.fullyResolved, true);
        assert.deepStrictEqual(flex.mass, concrete.mass);
        assertMapsEqual(projected.results, concrete.results);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.pendingEntries.length, 0);
        assert.strictEqual(projected.results.has(0 as PackedCombo), false);
    });

    it('matches concrete bounded non-book checkpoint shape at XP 30', () => {
        const { concrete, flex, projected } = runConcreteAndFlex(30, { threshold: 0n, maxIterations: 500 });

        assert.strictEqual(flex.exitReason, 'iterations');
        assert.strictEqual(flex.iterations, concrete.iterations);
        assert.deepStrictEqual(flex.mass, concrete.mass);
        assertMapsEqual(projected.results, concrete.results);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedPendingMass, BigInt(concrete.mass.units!.pending));
        assert.strictEqual(flex.pendingCount, concrete.pendingCount);
        assert.strictEqual(flex.largestPendingMass, concrete.largestPendingMass);
        assert.strictEqual(flex.activeResidueMass, concrete.activeResidueMass);
        assert.deepStrictEqual(normalizePending(projected.pendingEntries), normalizePending(concrete.pendingEntries));
        assert.ok(flex.pendingEntries.every(entry => entry.nodeKind === 'solid'));
    });
});

function createSolidGraph(): {
    graph: SearchGraph;
    solid: SolidFlexGraph;
    programs: FlexProgramStore;
} {
    const registry = RegistryFactory.build('1.21.11');
    const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
    const graph = new SearchGraph(kernel, kernel.getPool(30));
    const programs = new FlexProgramStore();
    const solid = new SolidFlexGraph(graph, programs, registry.indexToEnchant);
    return { graph, solid, programs };
}

function findConvergentPair(graph: SearchGraph, rootId: SearchGraphNodeId): ConvergentPair {
    const rootExpansion = graph.getExpansion(rootId);
    for (let leftRootIndex = 0; leftRootIndex < rootExpansion.edges.length; leftRootIndex++) {
        const leftEdge = rootExpansion.edges[leftRootIndex]!;
        const leftExpansion = graph.getExpansion(leftEdge.childId);
        for (let rightRootIndex = leftRootIndex + 1; rightRootIndex < rootExpansion.edges.length; rightRootIndex++) {
            const rightEdge = rootExpansion.edges[rightRootIndex]!;
            const fromLeft = findEdgeByPackedEnchant(leftExpansion.edges, rightEdge.entry.packedEnchant);
            if (!fromLeft) continue;

            const rightExpansion = graph.getExpansion(rightEdge.childId);
            const fromRight = findEdgeByPackedEnchant(rightExpansion.edges, leftEdge.entry.packedEnchant);
            if (fromRight && fromRight.childId === fromLeft.childId) {
                return { leftRootIndex, rightRootIndex, convergedChildId: fromLeft.childId };
            }
        }
    }

    assert.fail('No convergent compatible pair found for SolidFlexGraph test.');
}

function findEdgeByPackedEnchant(
    edges: readonly SearchGraphEdge[],
    packedEnchant: number
): SearchGraphEdge | undefined {
    return edges.find(edge => edge.entry.packedEnchant === packedEnchant);
}

function runConcreteAndFlex(
    xp: number,
    request: Parameters<SearchRun['searchToCheckpoint']>[0]
): {
    concrete: SearchRunSnapshot;
    flex: FlexRunSnapshot;
    projected: ReturnType<SolidFlexSearchRun['projectSnapshot']>;
} {
    const registry = RegistryFactory.build('1.21.11');
    const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
    const concreteRun = new SearchRun(kernel);
    const flexRun = new SolidFlexSearchRun(kernel);

    concreteRun.seedXp(xp);
    flexRun.seedXp(xp);

    const concrete = concreteRun.searchToCheckpoint(request);
    const flex = flexRun.searchToCheckpoint(request);
    const projected = flexRun.projectSnapshot(flex);
    return { concrete, flex, projected };
}

function assertMapsEqual(
    actual: ReadonlyMap<PackedCombo, bigint>,
    expected: ReadonlyMap<PackedCombo, bigint>
): void {
    assert.deepStrictEqual([...actual.entries()].sort(compareEntries), [...expected.entries()].sort(compareEntries));
}

function normalizePending(
    entries: readonly (FlexProjectedPendingEntry | SearchRunSnapshot['pendingEntries'][number])[]
): readonly string[] {
    return entries
        .map(entry => `${entry.graphId}:${String(entry.nodeId)}:${entry.combo}:${entry.count}:${String(entry.mass)}`)
        .sort();
}

function compareEntries(left: readonly [PackedCombo, bigint], right: readonly [PackedCombo, bigint]): number {
    return Number(left[0]) - Number(right[0]);
}
