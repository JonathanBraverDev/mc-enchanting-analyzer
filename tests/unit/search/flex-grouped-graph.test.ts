import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    RegistryFactory,
    RegistryKernel,
    SearchGraph,
    SearchRun,
    type PackedCombo
} from '#lib/index.js';
import type { SearchRunSnapshot } from '#lib/search/SearchRun.js';
import { ComboUtils, PRECISION } from '#utils/index.js';
import type { RegistryState } from '#types/index.js';
import {
    FlexProgramStore,
    GroupedFlexGraph,
    GroupedFlexSearchRun,
    type FlexChoiceEmission,
    type FlexEdge,
    type FlexEmission,
    type FlexFixedEmission,
    type FlexRunSnapshot
} from '#lib/search/flex/index.js';

const MASS_TOLERANCE = 1_000n;

interface GroupedGraphFixture {
    readonly registry: RegistryState;
    readonly kernel: RegistryKernel;
    readonly concrete: SearchGraph;
    readonly graph: GroupedFlexGraph;
    readonly programs: FlexProgramStore;
}

describe('GroupedFlexGraph', () => {
    it('collapses diamond sword damage alternatives into one PlexNode edge', () => {
        const fixture = createGraphFixture('sword', 'diamond', 30);
        const concreteRoot = fixture.concrete.getExpansion(fixture.concrete.getRootNode(30).id);
        const root = fixture.graph.getRootNode(30);
        const expansion = fixture.graph.getExpansion(root.id);
        const damageEdge = findChoiceEdgeByNames(fixture, expansion.edges, [
            'Sharpness',
            'Smite',
            'Bane of Arthropods'
        ]);
        const choice = getEdgeChoice(fixture, damageEdge);

        assert.strictEqual(expansion.probContinue, PRECISION);
        assert.strictEqual(expansion.totalWeight, concreteRoot.totalWeight);
        assert.ok(expansion.edges.length < concreteRoot.edges.length);
        assert.strictEqual(fixture.graph.getNode(damageEdge.childId).kind, 'plex');
        assert.deepStrictEqual(edgeChoiceNames(fixture, damageEdge), ['Bane of Arthropods', 'Sharpness', 'Smite']);
        assertChoiceWeightsByName(fixture, choice, {
            Sharpness: 10,
            Smite: 5,
            'Bane of Arthropods': 5
        });
        assert.strictEqual(damageEdge.weight, 20);
    });

    it('collapses modern book damage alternatives only when they share future state', () => {
        const fixture = createGraphFixture('book', 'book', 30);
        const expansion = fixture.graph.getExpansion(fixture.graph.getRootNode(30).id);
        const damageEdge = expansion.edges.find(edge => {
            const names = new Set(edgeChoiceNames(fixture, edge));
            return names.has('Sharpness')
                && names.has('Smite')
                && names.has('Bane of Arthropods')
                && names.has('Impaling')
                && names.has('Density')
                && names.has('Breach');
        });

        assert.ok(damageEdge, 'book fixture should expose a grouped damage choice');
        assert.strictEqual(fixture.graph.getNode(damageEdge.childId).kind, 'plex');
        assert.deepStrictEqual(edgeChoiceNames(fixture, damageEdge), [
            'Bane of Arthropods',
            'Breach',
            'Density',
            'Impaling',
            'Sharpness',
            'Smite'
        ]);
        assertChoiceWeightsByName(fixture, getEdgeChoice(fixture, damageEdge), {
            Sharpness: 10,
            Smite: 5,
            'Bane of Arthropods': 5,
            Impaling: 2,
            Density: 5,
            Breach: 2
        });
    });

    it('keeps trident V-shaped conflicts as singleton SolidNode edges', () => {
        const fixture = createGraphFixture('trident', 'trident', 30);
        const expansion = fixture.graph.getExpansion(fixture.graph.getRootNode(30).id);
        const tridentChoices = expansion.edges
            .map(edge => edgeChoiceNames(fixture, edge))
            .filter(names => names.some(name => ['Channeling', 'Loyalty', 'Riptide'].includes(name)))
            .sort((left, right) => left[0]!.localeCompare(right[0]!));

        assert.deepStrictEqual(tridentChoices, [['Channeling'], ['Loyalty'], ['Riptide']]);
        for (const names of tridentChoices) {
            const edge = findChoiceEdgeByNames(fixture, expansion.edges, names);
            assert.strictEqual(fixture.graph.getNode(edge.childId).kind, 'solid');
        }
    });

    it('keeps singleton transitions solid and grouped transitions plex', () => {
        const fixture = createGraphFixture('sword', 'diamond', 30);
        const expansion = fixture.graph.getExpansion(fixture.graph.getRootNode(30).id);
        const groupedEdge = expansion.edges.find(edge => fixture.graph.getNode(edge.childId).kind === 'plex');
        const singletonEdge = expansion.edges.find(edge => fixture.graph.getNode(edge.childId).kind === 'solid');

        assert.ok(groupedEdge, 'sword root should contain at least one grouped edge');
        assert.ok(singletonEdge, 'sword root should contain at least one singleton edge');
        assert.strictEqual(getLastEmission(fixture, groupedEdge).kind, 'choice');
        assert.strictEqual(getLastEmission(fixture, singletonEdge).kind, 'fixed');
    });

    it('expands non-root singleton children with halved level and concrete-equivalent total weight', () => {
        const fixture = createGraphFixture('sword', 'diamond', 30);
        const groupedRoot = fixture.graph.getExpansion(fixture.graph.getRootNode(30).id);
        const singletonEdge = groupedRoot.edges.find(edge => getLastEmission(fixture, edge).kind === 'fixed');
        assert.ok(singletonEdge, 'fixture should expose a singleton root transition');

        const fixed = getLastEmission(fixture, singletonEdge) as FlexFixedEmission;
        const concreteRoot = fixture.concrete.getExpansion(fixture.concrete.getRootNode(30).id);
        const concreteEdge = concreteRoot.edges.find(edge => edge.entry.packedEnchant === fixed.packedEnchant);
        assert.ok(concreteEdge, 'concrete graph should expose the same singleton transition');

        const groupedChildExpansion = fixture.graph.getExpansion(singletonEdge.childId);
        const concreteChildExpansion = fixture.concrete.getExpansion(concreteEdge.childId);

        assert.strictEqual(fixture.graph.getNodeCurrentLevel(singletonEdge.childId), 30);
        assert.strictEqual(groupedChildExpansion.totalWeight, concreteChildExpansion.totalWeight);
        assert.ok(groupedChildExpansion.edges.every(edge => fixture.graph.getNodeCurrentLevel(edge.childId) === 15));
    });

    it('keeps no-eligible, single-book, and max-enchants terminal behavior compatible with Flex', () => {
        const pickaxe = createGraphFixture('pickaxe', 'diamond', 30);
        const noEligibleExpansion = followFirstPathUntil(pickaxe.graph, pickaxe.graph.getRootNode(30).id, expansion => expansion.edges.length === 0);
        assert.strictEqual(noEligibleExpansion.terminalReason, null);
        assert.strictEqual(noEligibleExpansion.totalWeight, 0);

        const book = createGraphFixture('book', 'book', 30, '1.4.6');
        const bookRoot = book.graph.getExpansion(book.graph.getRootNode(30).id);
        const bookChildExpansion = book.graph.getExpansion(bookRoot.edges[0]!.childId);
        assert.strictEqual(bookChildExpansion.terminalReason, null);
        assert.strictEqual(bookChildExpansion.probContinue, 0n);
        assert.strictEqual(bookChildExpansion.edges.length, 0);

        const sword = createGraphFixture('sword', 'diamond', 30);
        const maxExpansion = followFirstPathUntil(sword.graph, sword.graph.getRootNode(30).id, expansion => expansion.node.count >= 6);
        assert.strictEqual(maxExpansion.terminalReason, 'overflow');
        assert.strictEqual(maxExpansion.edges.length, 0);
    });
});

describe('GroupedFlexSearchRun', () => {
    it('matches concrete projected public rows for low-XP diamond sword', () => {
        assertExhaustiveProjectedParity('1.21.11', 'sword', 'diamond', 1, true);
    });

    it('matches concrete projected public rows for low-XP single-book search', () => {
        assertExhaustiveProjectedParity('1.4.6', 'book', 'book', 1, false);
    });

    it('produces a bounded XP 30 checkpoint with PlexNode programs and conserved resolved source mass', () => {
        const { run, flex, projected } = runConcreteAndGrouped('1.21.11', 'sword', 'diamond', 30, {
            threshold: 0n,
            maxIterations: 500
        });

        assert.strictEqual(flex.exitReason, 'iterations');
        assert.ok(flex.pendingEntries.length > 0);
        assert.ok(projected.pendingEntries.length > 0);
        assert.strictEqual(projected.projectedMass + projected.projectionLoss, projected.sourceMass);
        assert.strictEqual(projected.results.has(0 as PackedCombo), false);
        assert.ok(hasPlexSourceProgram(run, flex), 'checkpoint should include at least one PlexNode source program');
    });
});

function createGraphFixture(
    item: string,
    material: string,
    level: number,
    version = '1.21.11'
): GroupedGraphFixture {
    const registry = RegistryFactory.build(version);
    const kernel = new RegistryKernel({ registry, item, material });
    const pool = kernel.getPool(level);
    const concrete = new SearchGraph(kernel, pool);
    const programs = new FlexProgramStore();
    const graph = new GroupedFlexGraph(kernel, pool, programs);
    return { registry, kernel, concrete, graph, programs };
}

function findChoiceEdgeByNames(
    fixture: GroupedGraphFixture,
    edges: readonly FlexEdge[],
    expectedNames: readonly string[]
): FlexEdge {
    const expected = [...expectedNames].sort();
    const edge = edges.find(candidate => {
        const names = edgeChoiceNames(fixture, candidate);
        return names.length === expected.length && names.every((name, index) => name === expected[index]);
    });
    assert.ok(edge, `Expected grouped edge ${expected.join(', ')}`);
    return edge;
}

function edgeChoiceNames(fixture: GroupedGraphFixture, edge: FlexEdge): readonly string[] {
    const emission = getLastEmission(fixture, edge);
    const packedEnchants = emission.kind === 'fixed'
        ? [emission.packedEnchant]
        : emission.alternatives.map(alternative => alternative.packedEnchant);
    return packedEnchants
        .map(packed => fixture.registry.revIdMap[ComboUtils.getEnchantId(packed)]!)
        .sort();
}

function getEdgeChoice(fixture: GroupedGraphFixture, edge: FlexEdge): FlexChoiceEmission {
    const emission = getLastEmission(fixture, edge);
    assert.strictEqual(emission.kind, 'choice');
    return emission;
}

function assertChoiceWeightsByName(
    fixture: GroupedGraphFixture,
    choice: FlexChoiceEmission,
    expected: Readonly<Record<string, number>>
): void {
    const actual = new Map(choice.alternatives.map(alternative => [
        fixture.registry.revIdMap[ComboUtils.getEnchantId(alternative.packedEnchant)]!,
        alternative.weight
    ]));
    assert.deepStrictEqual(Object.fromEntries([...actual.entries()].sort()), Object.fromEntries(Object.entries(expected).sort()));
}

function getLastEmission(fixture: GroupedGraphFixture, edge: FlexEdge): FlexEmission {
    const program = fixture.programs.getProgram(fixture.graph.getProgramId(edge.childId));
    const emission = program[program.length - 1];
    assert.ok(emission, 'edge child should have at least one program emission');
    return emission;
}

function followFirstPathUntil(
    graph: GroupedFlexGraph,
    rootId: ReturnType<GroupedFlexGraph['getRootNode']>['id'],
    predicate: (expansion: ReturnType<GroupedFlexGraph['getExpansion']>) => boolean
): ReturnType<GroupedFlexGraph['getExpansion']> {
    let expansion = graph.getExpansion(rootId);
    for (let guard = 0; guard < 16; guard++) {
        if (predicate(expansion)) return expansion;
        const edge = expansion.edges[0];
        assert.ok(edge, 'expected first-path fixture to keep expanding');
        expansion = graph.getExpansion(edge.childId);
    }
    assert.fail('First-path fixture did not reach the requested expansion.');
}

function assertExhaustiveProjectedParity(
    version: string,
    item: string,
    material: string,
    xp: number,
    requirePlexSource: boolean
): void {
    const { run, flex, concrete, projected } = runConcreteAndGrouped(version, item, material, xp, { exhaustive: true });

    assert.strictEqual(concrete.fullyResolved, true);
    assert.strictEqual(flex.fullyResolved, true);
    assertProjectedRowsApproximatelyEqual(projected.results, concrete.results);
    assert.strictEqual(projected.projectedMass + projected.projectionLoss, projected.sourceMass);
    assert.strictEqual(projected.results.has(0 as PackedCombo), false);
    if (requirePlexSource) {
        assert.ok(hasPlexSourceProgram(run, flex), `${version} ${item}/${material} XP ${String(xp)} should exercise PlexNode programs`);
    }
}

function runConcreteAndGrouped(
    version: string,
    item: string,
    material: string,
    xp: number,
    request: Parameters<SearchRun['searchToCheckpoint']>[0]
): {
    run: GroupedFlexSearchRun;
    concrete: SearchRunSnapshot;
    flex: FlexRunSnapshot;
    projected: ReturnType<GroupedFlexSearchRun['projectSnapshot']>;
} {
    const registry = RegistryFactory.build(version);
    const kernel = new RegistryKernel({ registry, item, material });
    const concreteRun = new SearchRun(kernel);
    const groupedRun = new GroupedFlexSearchRun(kernel);

    concreteRun.seedXp(xp);
    groupedRun.seedXp(xp);

    const concrete = concreteRun.searchToCheckpoint(request);
    const flex = groupedRun.searchToCheckpoint(request);
    return {
        run: groupedRun,
        concrete,
        flex,
        projected: groupedRun.projectSnapshot(flex)
    };
}

function assertProjectedRowsApproximatelyEqual(
    actual: ReadonlyMap<PackedCombo, bigint>,
    expected: ReadonlyMap<PackedCombo, bigint>
): void {
    const keys = new Set<PackedCombo>([...actual.keys(), ...expected.keys()]);
    for (const key of [...keys].sort((left, right) => Number(left) - Number(right))) {
        const actualMass = actual.get(key) ?? 0n;
        const expectedMass = expected.get(key) ?? 0n;
        const delta = actualMass > expectedMass ? actualMass - expectedMass : expectedMass - actualMass;
        assert.ok(
            delta <= MASS_TOLERANCE,
            `combo ${String(key)} expected ${String(expectedMass)}, got ${String(actualMass)}, delta ${String(delta)}`
        );
    }
}

function hasPlexSourceProgram(run: GroupedFlexSearchRun, snapshot: FlexRunSnapshot): boolean {
    for (const programId of snapshot.results.keys()) {
        if (run.programs.hasChoice(programId)) return true;
    }
    return snapshot.pendingEntries.some(entry => run.programs.hasChoice(entry.programId));
}
