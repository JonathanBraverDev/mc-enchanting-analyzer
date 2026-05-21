import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    RegistryFactory,
    RegistryKernel,
    SearchGraph,
    SearchRun,
    type PackedCombo,
    type SearchGraphExpansion,
    type SearchGraphNodeId
} from '#lib/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import type { SearchRunSnapshot } from '#lib/search/SearchRun.js';
import {
    FlexProgramStore,
    RegistryFlexGraph,
    RegistryFlexSearchRun,
    type FlexNodeId,
    type FlexProjectedPendingEntry,
    type FlexRunSnapshot
} from '#lib/search/flex/index.js';

interface GraphPair {
    readonly concrete: SearchGraph;
    readonly flex: RegistryFlexGraph;
    readonly programs: FlexProgramStore;
}

interface ConcretePath {
    readonly nodeId: SearchGraphNodeId;
    readonly edgeIndexes: readonly number[];
}

describe('RegistryFlexGraph', () => {
    it('matches concrete root expansion weights and first-level combos', () => {
        const { concrete, flex, programs } = createGraphPair('sword', 'diamond', 30);
        const concreteRoot = concrete.getRootNode(30);
        const flexRoot = flex.getRootNode(30);
        const concreteExpansion = concrete.getExpansion(concreteRoot.id);
        const flexExpansion = flex.getExpansion(flexRoot.id);

        assert.strictEqual(flexRoot.kind, 'solid');
        assert.strictEqual(flexRoot.programId, programs.empty);
        assertExpansionCompatible(concrete, concreteExpansion, flex, flexExpansion);
    });

    it('matches concrete conflict filtering from registry pool data', () => {
        const { concrete, flex } = createGraphPair('sword', 'diamond', 30);
        const concreteRoot = concrete.getRootNode(30);
        const concreteRootExpansion = concrete.getExpansion(concreteRoot.id);
        const flexRootExpansion = flex.getExpansion(flex.getRootNode(30).id);
        const childIndex = concreteRootExpansion.edges.findIndex(edge => {
            const expansion = concrete.getExpansion(edge.childId);
            return expansion.edges.length < concreteRootExpansion.edges.length - 1;
        });

        assert.notStrictEqual(childIndex, -1, 'test case should include a root enchant that filters conflicts');

        const concreteChildExpansion = concrete.getExpansion(concreteRootExpansion.edges[childIndex]!.childId);
        const flexChildExpansion = flex.getExpansion(flexRootExpansion.edges[childIndex]!.childId);
        assertExpansionCompatible(concrete, concreteChildExpansion, flex, flexChildExpansion);
    });

    it('reuses one SolidNode for convergent compatible selection order', () => {
        const { concrete, flex } = createGraphPair('sword', 'diamond', 30);
        const concreteRoot = concrete.getRootNode(30);
        const pair = findConvergentPair(concrete, concreteRoot.id);
        const targetCombo = concrete.getNodeCombo(pair.convergedChildId);
        const flexRootExpansion = flex.getExpansion(flex.getRootNode(30).id);
        const leftChild = flexRootExpansion.edges[pair.leftRootIndex]!.childId;
        const rightChild = flexRootExpansion.edges[pair.rightRootIndex]!.childId;
        const leftFinal = flex.getExpansion(leftChild).edges.find(edge => flex.getNodeCombo(edge.childId) === targetCombo);
        const rightFinal = flex.getExpansion(rightChild).edges.find(edge => flex.getNodeCombo(edge.childId) === targetCombo);

        assert.ok(leftFinal);
        assert.ok(rightFinal);
        assert.strictEqual(leftFinal.childId, rightFinal.childId);
        assert.strictEqual(flex.getProgramId(leftFinal.childId), flex.getProgramId(rightFinal.childId));
        assert.strictEqual(flex.getNode(leftFinal.childId).kind, 'solid');
    });

    it('matches concrete no-eligible terminal expansion shape', () => {
        const { concrete, flex } = createGraphPair('pickaxe', 'diamond', 30);
        const path = findConcretePath(
            concrete,
            concrete.getRootNode(30).id,
            expansion => expansion.terminalReason === 'no-eligible'
        );
        const flexNodeId = followFlexPath(flex, flex.getRootNode(30).id, path.edgeIndexes);

        assertExpansionCompatible(concrete, concrete.getExpansion(path.nodeId), flex, flex.getExpansion(flexNodeId));
    });

    it('matches concrete single-book and max-enchants terminal behavior', () => {
        const book = createGraphPair('book', 'book', 30, '1.4.6');
        const bookConcreteRootExpansion = book.concrete.getExpansion(book.concrete.getRootNode(30).id);
        const bookFlexRootExpansion = book.flex.getExpansion(book.flex.getRootNode(30).id);
        const bookConcreteChildExpansion = book.concrete.getExpansion(bookConcreteRootExpansion.edges[0]!.childId);
        const bookFlexChildExpansion = book.flex.getExpansion(bookFlexRootExpansion.edges[0]!.childId);

        assert.strictEqual(bookConcreteChildExpansion.terminalReason, 'single-book');
        assertExpansionCompatible(book.concrete, bookConcreteChildExpansion, book.flex, bookFlexChildExpansion);

        const sword = createGraphPair('sword', 'diamond', 30);
        const maxPath = findConcretePath(
            sword.concrete,
            sword.concrete.getRootNode(30).id,
            expansion => expansion.terminalReason === 'max-enchants'
        );
        const flexMaxNodeId = followFlexPath(sword.flex, sword.flex.getRootNode(30).id, maxPath.edgeIndexes);
        const flexMaxExpansion = sword.flex.getExpansion(flexMaxNodeId);

        assert.strictEqual(flexMaxExpansion.terminalReason, 'overflow');
        assertExpansionCompatible(sword.concrete, sword.concrete.getExpansion(maxPath.nodeId), sword.flex, flexMaxExpansion);
    });
});

describe('RegistryFlexSearchRun', () => {
    it('matches concrete exhaustive non-book search at low XP', () => {
        const { concrete, flex, projected } = runConcreteAndFlex(1, { exhaustive: true });

        assert.strictEqual(flex.fullyResolved, true);
        assert.deepStrictEqual(flex.mass, concrete.mass);
        assertMapsEqual(projected.results, concrete.results);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.pendingEntries.length, 0);
        assert.strictEqual(projected.results.has(0 as PackedCombo), false);
    });

    it('matches concrete bounded non-book checkpoint shape at XP 15', () => {
        assertBoundedCheckpointParity(15, 500);
    });

    it('matches concrete bounded non-book checkpoint shape at XP 30', () => {
        assertBoundedCheckpointParity(30, 500);
    });

    it('matches concrete probability-floor sieving at XP 30', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const concreteRun = new SearchRun(kernel);
        const flexRun = new RegistryFlexSearchRun(kernel);

        concreteRun.seedXp(30);
        flexRun.seedXp(30);

        const concrete = concreteRun.searchToCheckpoint({
            threshold: 0n,
            maxIterations: 100_000,
            probabilityFloor: ENGINE_LIMITS.SYSTEM_THRESHOLD_FLOOR
        });
        const flex = flexRun.searchToCheckpoint({
            threshold: 0n,
            maxIterations: 100_000
        });
        const projected = flexRun.projectSnapshot(flex);

        assert.strictEqual(concrete.fullyResolved, true);
        assert.strictEqual(flex.fullyResolved, true);
        assert.strictEqual(flex.iterations, concrete.iterations);
        assert.deepStrictEqual(flex.mass, concrete.mass);
        assert.ok(BigInt(flex.mass.units!.sieved) > 0n);
        assertMapsEqual(projected.results, concrete.results);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.pendingEntries.length, 0);
        assert.strictEqual(flex.pendingCount, concrete.pendingCount);
        assert.strictEqual(flex.activeResidueMass, concrete.activeResidueMass);
    });
});

function createGraphPair(
    item: string,
    material: string,
    level: number,
    version = '1.21.11'
): GraphPair {
    const registry = RegistryFactory.build(version);
    const kernel = new RegistryKernel({ registry, item, material });
    const pool = kernel.getPool(level);
    const concrete = new SearchGraph(kernel, pool);
    const programs = new FlexProgramStore();
    const flex = new RegistryFlexGraph(kernel, pool, programs);
    return { concrete, flex, programs };
}

function assertExpansionCompatible(
    concrete: SearchGraph,
    concreteExpansion: SearchGraphExpansion,
    flex: RegistryFlexGraph,
    flexExpansion: ReturnType<RegistryFlexGraph['getExpansion']>
): void {
    assert.strictEqual(flexExpansion.probContinue, concreteExpansion.probContinue);
    assert.strictEqual(flexExpansion.totalWeight, concreteExpansion.totalWeight);
    assert.strictEqual(
        flexExpansion.terminalReason,
        concreteExpansion.terminalReason === 'max-enchants' ? 'overflow' : null
    );
    assert.deepStrictEqual(
        flexExpansion.edges.map(edge => Object.freeze({
            weight: edge.weight,
            combo: flex.getNodeCombo(edge.childId),
            count: flex.getNodeCount(edge.childId)
        })),
        concreteExpansion.edges.map(edge => Object.freeze({
            weight: edge.weight,
            combo: concrete.getNodeCombo(edge.childId),
            count: concrete.getNodeCount(edge.childId)
        }))
    );
}

function findConvergentPair(
    graph: SearchGraph,
    rootId: SearchGraphNodeId
): {
    readonly leftRootIndex: number;
    readonly rightRootIndex: number;
    readonly convergedChildId: SearchGraphNodeId;
} {
    const rootExpansion = graph.getExpansion(rootId);
    for (let leftRootIndex = 0; leftRootIndex < rootExpansion.edges.length; leftRootIndex++) {
        const leftEdge = rootExpansion.edges[leftRootIndex]!;
        const leftExpansion = graph.getExpansion(leftEdge.childId);
        for (let rightRootIndex = leftRootIndex + 1; rightRootIndex < rootExpansion.edges.length; rightRootIndex++) {
            const rightEdge = rootExpansion.edges[rightRootIndex]!;
            const fromLeft = leftExpansion.edges.find(edge => edge.entry.packedEnchant === rightEdge.entry.packedEnchant);
            if (!fromLeft) continue;

            const rightExpansion = graph.getExpansion(rightEdge.childId);
            const fromRight = rightExpansion.edges.find(edge => edge.entry.packedEnchant === leftEdge.entry.packedEnchant);
            if (fromRight && fromRight.childId === fromLeft.childId) {
                return { leftRootIndex, rightRootIndex, convergedChildId: fromLeft.childId };
            }
        }
    }

    assert.fail('No convergent compatible pair found for RegistryFlexGraph test.');
}

function findConcretePath(
    graph: SearchGraph,
    rootId: SearchGraphNodeId,
    predicate: (expansion: SearchGraphExpansion) => boolean
): ConcretePath {
    const queue: ConcretePath[] = [{ nodeId: rootId, edgeIndexes: [] }];
    const seen = new Set<number>();

    while (queue.length > 0 && seen.size < 20_000) {
        const current = queue.shift()!;
        const nodeKey = current.nodeId as number;
        if (seen.has(nodeKey)) continue;
        seen.add(nodeKey);

        const expansion = graph.getExpansion(current.nodeId);
        if (predicate(expansion)) return current;

        for (let edgeIndex = 0; edgeIndex < expansion.edges.length; edgeIndex++) {
            queue.push(Object.freeze({
                nodeId: expansion.edges[edgeIndex]!.childId,
                edgeIndexes: Object.freeze([...current.edgeIndexes, edgeIndex])
            }));
        }
    }

    assert.fail('No concrete graph path matched the requested expansion predicate.');
}

function followFlexPath(
    graph: RegistryFlexGraph,
    rootId: FlexNodeId,
    edgeIndexes: readonly number[]
): FlexNodeId {
    let nodeId = rootId;
    for (const edgeIndex of edgeIndexes) {
        const expansion = graph.getExpansion(nodeId);
        const edge = expansion.edges[edgeIndex];
        assert.ok(edge, `Flex expansion is missing edge index ${String(edgeIndex)}.`);
        nodeId = edge.childId;
    }
    return nodeId;
}

function runConcreteAndFlex(
    xp: number,
    request: Parameters<SearchRun['searchToCheckpoint']>[0]
): {
    concrete: SearchRunSnapshot;
    flex: FlexRunSnapshot;
    projected: ReturnType<RegistryFlexSearchRun['projectSnapshot']>;
} {
    const registry = RegistryFactory.build('1.21.11');
    const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
    const concreteRun = new SearchRun(kernel);
    const flexRun = new RegistryFlexSearchRun(kernel);

    concreteRun.seedXp(xp);
    flexRun.seedXp(xp);

    const concrete = concreteRun.searchToCheckpoint(request);
    const flex = flexRun.searchToCheckpoint(request);
    const projected = flexRun.projectSnapshot(flex);
    return { concrete, flex, projected };
}

function assertBoundedCheckpointParity(xp: number, maxIterations: number): void {
    const { concrete, flex, projected } = runConcreteAndFlex(xp, { threshold: 0n, maxIterations });

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
