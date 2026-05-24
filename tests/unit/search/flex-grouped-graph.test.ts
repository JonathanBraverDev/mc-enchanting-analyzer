import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RegistryFactory } from '#core/factory.js';
import { RegistryKernel } from '#lib/search/index.js';
import { SearchGraph } from '#lib/search/SearchGraph.js';
import { SearchRun } from '#lib/search/SearchRun.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import type { SearchRunSnapshot } from '#lib/search/SearchSnapshot.js';
import { type PackedCombo } from '#types/index.js';
import { ComboUtils, PRECISION, ProbUtils } from '#utils/index.js';
import type { RegistryState } from '#types/index.js';
import {
    FlexProgramStore,
    GroupedFlexGraph,
    GroupedFlexSearchRun,
    type FlexChoiceEmission,
    type FlexEdge,
    type FlexEmission,
    type FlexFixedEmission,
    type FlexNativeCheckpoint,
    type FlexRunSnapshot
} from '#lib/search/flex/index.js';

const MASS_TOLERANCE = 1_000n;
const SYSTEM_FLOOR_UNITS = ProbUtils.toBigInt(ENGINE_LIMITS.SYSTEM_THRESHOLD_FLOOR);
const FLOOR_MASS_TOLERANCE = SYSTEM_FLOOR_UNITS * 10n;

interface GroupedGraphFixture {
    readonly registry: RegistryState;
    readonly kernel: RegistryKernel;
    readonly concrete: SearchGraph;
    readonly graph: GroupedFlexGraph;
    readonly programs: FlexProgramStore;
}

interface HotExpansionSnapshot {
    readonly nodeId: ReturnType<GroupedFlexGraph['getRootNode']>['id'];
    readonly programId: number;
    readonly nodeKind: string;
    readonly count: number;
    readonly probContinue: bigint;
    readonly totalWeight: number;
    readonly clueIncompatibleWeight: number;
    readonly terminalReason: ReturnType<GroupedFlexGraph['getExpansion']>['terminalReason'];
    readonly edges: readonly { readonly weight: number; readonly childId: ReturnType<GroupedFlexGraph['getRootNode']>['id'] }[];
}

describe('GroupedFlexGraph', () => {
    it('exposes the same edge order and weights through the hot-path expansion view', () => {
        const fixture = createGraphFixture('book', 'book', 30);
        const root = fixture.graph.getRootNode(30);
        const hot = captureHotExpansion(fixture.graph, root.id);
        const debug = fixture.graph.getExpansion(root.id);

        assert.strictEqual(hot.nodeId, debug.node.id);
        assert.strictEqual(hot.programId, debug.node.programId);
        assert.strictEqual(hot.nodeKind, debug.node.kind);
        assert.strictEqual(hot.count, debug.node.count);
        assert.strictEqual(hot.probContinue, debug.probContinue);
        assert.strictEqual(hot.totalWeight, debug.totalWeight);
        assert.strictEqual(hot.clueIncompatibleWeight, debug.clueIncompatibleWeight ?? 0);
        assert.strictEqual(hot.terminalReason, debug.terminalReason);
        assert.deepStrictEqual(hot.edges, debug.edges.map(edge => ({
            weight: edge.weight,
            childId: edge.childId
        })));
    });

    it('reuses grouped shapes across nodes with the same exclusion mask and clue mode', () => {
        const fixture = createGraphFixture('book', 'book', 30);
        const firstRoot = fixture.graph.getRootNode(30);
        fixture.graph.withSearchExpansion!(firstRoot.id, () => undefined);
        const afterFirst = fixture.graph.getMemoryStats();

        const secondRoot = fixture.graph.getRootNode(20);
        fixture.graph.withSearchExpansion!(secondRoot.id, () => undefined);
        const afterSecond = fixture.graph.getMemoryStats();

        assert.strictEqual(afterFirst.groupingBuildCount, 1);
        assert.strictEqual(afterSecond.groupingBuildCount, 1);
        assert.strictEqual(afterSecond.searchExpansionCount, afterFirst.searchExpansionCount + 1);
    });

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

    it('reports structural Solid and Plex node counts without scanning diagnostics', () => {
        const fixture = createGraphFixture('sword', 'diamond', 30);
        const root = fixture.graph.getRootNode(30);
        fixture.graph.getExpansion(root.id);
        const stats = fixture.graph.getMemoryStats();

        assert.strictEqual(stats.nodeCount, stats.solidNodeCount + stats.plexNodeCount);
        assert.ok(stats.solidNodeCount > 0, 'root and singleton transitions should count as Solid nodes');
        assert.ok(stats.plexNodeCount > 0, 'grouped choice transitions should count as Plex nodes');
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

    it('matches concrete projected public rows for low-XP multi-book searches', () => {
        assertExhaustiveProjectedParity('1.7.2', 'book', 'book', 1, false);
        assertExhaustiveProjectedParity('1.13', 'book', 'book', 1, true);
        assertExhaustiveProjectedParity('1.21.11', 'book', 'book', 1, true);
    });

    it('projects exact clue-conditioned grouped results like concrete V7', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const targetClueId = findPoolEnchantByName(registry, kernel, 30, 'Sharpness');
        const concreteRun = new SearchRun(kernel, { targetClueId });
        const groupedRun = new GroupedFlexSearchRun(kernel, { targetClueId });
        const request = { exhaustive: true } as const;

        concreteRun.seedXp(30);
        groupedRun.seedXp(30);
        const concrete = concreteRun.searchToCheckpoint(request);
        const flex = groupedRun.searchToCheckpoint(request);
        const native = groupedRun.buildEngineSnapshot(flex);

        assert.strictEqual(concrete.fullyResolved, true);
        assert.strictEqual(flex.fullyResolved, true);
        assert.strictEqual(flex.iterations, concrete.iterations);
        assertProjectedRowsApproximatelyEqual(native.snapshot.results, concrete.results);
        assert.ok(BigInt(flex.mass.units!.clueIncompatible) > 0n);
        assert.ok(native.resolvedClueIncompatible > 0n);
        assert.strictEqual(
            BigInt(native.snapshot.mass.units!.resolved) + native.resolvedClueIncompatible + native.resolvedProjectionLoss,
            BigInt(flex.mass.units!.resolved)
        );
        assert.strictEqual(native.snapshot.results.has(0 as PackedCombo), false);
        for (const combo of native.snapshot.results.keys()) {
            assert.ok(comboContainsExactEnchant(combo, targetClueId, registry.indexToEnchant));
        }
    });

    it('produces a bounded XP 30 checkpoint with PlexNode programs and conserved resolved source mass', () => {
        const { run, flex, native } = runConcreteAndGrouped('1.21.11', 'sword', 'diamond', 30, {
            threshold: 0n,
            maxIterations: 500,
            probabilityFloor: 0n
        });

        assert.strictEqual(flex.exitReason, 'iterations');
        assert.ok(flex.pendingEntries.length > 0);
        assert.ok(native.snapshot.pendingAggregates);
        assert.strictEqual(
            BigInt(native.snapshot.mass.units!.resolved) + native.resolvedClueIncompatible + native.resolvedProjectionLoss,
            BigInt(flex.mass.units!.resolved)
        );
        assert.strictEqual(native.snapshot.results.has(0 as PackedCombo), false);
        assert.ok(hasPlexSourceProgram(run, flex), 'checkpoint should include at least one PlexNode source program');
    });

    it('keeps incremental residue diagnostics aligned with a full residue scan', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new GroupedFlexSearchRun(kernel);
        run.seedXp(30);

        const snapshot = run.searchToCheckpoint({
            threshold: 0n,
            maxIterations: 500,
            probabilityFloor: 0n
        });
        const scanned = run.scanActiveResidueStatsForDiagnostics();

        assert.ok(snapshot.activeResidueCount > 0);
        assert.ok(snapshot.activeResidueMass > 0n);
        assert.strictEqual(snapshot.activeResidueCount, scanned.count);
        assert.strictEqual(snapshot.activeResidueMass, scanned.mass);
    });

    it('applies probability-floor sieving with grouped PlexNode projection parity', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const concreteRun = new SearchRun(kernel);
        const groupedRun = new GroupedFlexSearchRun(kernel);

        concreteRun.seedXp(30);
        groupedRun.seedXp(30);

        const concrete = concreteRun.searchToCheckpoint({
            threshold: 0n,
            maxIterations: 100_000,
            probabilityFloor: ENGINE_LIMITS.SYSTEM_THRESHOLD_FLOOR
        });
        const flex = groupedRun.searchToCheckpoint({
            threshold: 0n,
            maxIterations: 100_000
        });
        const native = groupedRun.buildEngineSnapshot(flex);

        assert.strictEqual(concrete.fullyResolved, true);
        assert.strictEqual(flex.fullyResolved, true);
        assert.strictEqual(flex.pendingCount, 0);
        assert.ok(BigInt(flex.mass.units!.sieved) > 0n);
        assertBigintApproximatelyEqual(BigInt(flex.mass.units!.resolved), BigInt(concrete.mass.units!.resolved), 'resolved mass', FLOOR_MASS_TOLERANCE);
        assertBigintApproximatelyEqual(BigInt(flex.mass.units!.sieved), BigInt(concrete.mass.units!.sieved), 'sieved mass', FLOOR_MASS_TOLERANCE);
        assertBigintApproximatelyEqual(BigInt(flex.mass.units!.rounding), BigInt(concrete.mass.units!.rounding), 'rounding mass', FLOOR_MASS_TOLERANCE);
        assertProjectedRowsApproximatelyEqual(native.snapshot.results, concrete.results, FLOOR_MASS_TOLERANCE);
        assert.strictEqual(
            BigInt(native.snapshot.mass.units!.resolved) + native.resolvedClueIncompatible + native.resolvedProjectionLoss,
            BigInt(flex.mass.units!.resolved)
        );
        assert.strictEqual(native.snapshot.results.has(0 as PackedCombo), false);
        assert.ok(hasPlexSourceProgram(groupedRun, flex), 'floor fixture should exercise PlexNode source programs');
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

function captureHotExpansion(
    graph: GroupedFlexGraph,
    nodeId: ReturnType<GroupedFlexGraph['getRootNode']>['id']
): HotExpansionSnapshot {
    let captured: HotExpansionSnapshot | undefined;
    graph.withSearchExpansion(nodeId, expansion => {
        captured = {
            nodeId: expansion.nodeId,
            programId: expansion.programId,
            nodeKind: expansion.nodeKind,
            count: expansion.count,
            probContinue: expansion.probContinue,
            totalWeight: expansion.totalWeight,
            clueIncompatibleWeight: expansion.clueIncompatibleWeight ?? 0,
            terminalReason: expansion.terminalReason,
            edges: Object.freeze(Array.from({ length: expansion.edgeCount }, (_, edgeIndex) => Object.freeze({
                weight: expansion.edgeWeights[edgeIndex]!,
                childId: expansion.edgeChildIds[edgeIndex]! as ReturnType<GroupedFlexGraph['getRootNode']>['id']
            })))
        };
    });
    assert.ok(captured, 'hot-path expansion callback should run');
    return captured;
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

function findPoolEnchantByName(
    registry: RegistryState,
    kernel: RegistryKernel,
    level: number,
    name: string
): number {
    const entry = kernel.getPool(level).entries.find(candidate =>
        registry.revIdMap[ComboUtils.getEnchantId(candidate.packedEnchant)] === name
    );
    assert.ok(entry, `Expected level ${String(level)} pool to include ${name}`);
    return entry.packedEnchant;
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
    const { run, flex, concrete, native } = runConcreteAndGrouped(version, item, material, xp, { exhaustive: true });

    assert.strictEqual(concrete.fullyResolved, true);
    assert.strictEqual(flex.fullyResolved, true);
    assertProjectedRowsApproximatelyEqual(native.snapshot.results, concrete.results);
    assert.strictEqual(
        BigInt(native.snapshot.mass.units!.resolved) + native.resolvedClueIncompatible + native.resolvedProjectionLoss,
        BigInt(flex.mass.units!.resolved)
    );
    assert.strictEqual(native.snapshot.results.has(0 as PackedCombo), false);
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
    native: FlexNativeCheckpoint;
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
        native: groupedRun.buildEngineSnapshot(flex)
    };
}

function assertProjectedRowsApproximatelyEqual(
    actual: ReadonlyMap<PackedCombo, bigint>,
    expected: ReadonlyMap<PackedCombo, bigint>,
    tolerance: bigint = MASS_TOLERANCE
): void {
    const keys = new Set<PackedCombo>([...actual.keys(), ...expected.keys()]);
    for (const key of [...keys].sort((left, right) => Number(left) - Number(right))) {
        const actualMass = actual.get(key) ?? 0n;
        const expectedMass = expected.get(key) ?? 0n;
        const delta = actualMass > expectedMass ? actualMass - expectedMass : expectedMass - actualMass;
        assert.ok(
            delta <= tolerance,
            `combo ${String(key)} expected ${String(expectedMass)}, got ${String(actualMass)}, delta ${String(delta)}`
        );
    }
}

function assertBigintApproximatelyEqual(
    actual: bigint,
    expected: bigint,
    label: string,
    tolerance: bigint = MASS_TOLERANCE
): void {
    const delta = actual > expected ? actual - expected : expected - actual;
    assert.ok(delta <= tolerance, `${label}: expected ${String(expected)}, got ${String(actual)}, delta ${String(delta)}`);
}

function comboContainsExactEnchant(combo: PackedCombo, targetClueId: number, indexToEnchant: number[]): boolean {
    return ComboUtils.unpack(combo, indexToEnchant).some(enchant => enchant === targetClueId);
}

function hasPlexSourceProgram(run: GroupedFlexSearchRun, snapshot: FlexRunSnapshot): boolean {
    for (const programId of snapshot.results.keys()) {
        if (run.programs.hasChoice(programId)) return true;
    }
    return snapshot.pendingEntries.some(entry => run.programs.hasChoice(entry.programId));
}
