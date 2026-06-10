import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RegistryFactory } from '#core/factory.js';
import { RegistryKernel } from '#lib/search/index.js';
import {
    FlexSearchGraph,
    FlexSearchProjector,
    FlexSearchRun,
    RankSelectionStore
} from '#lib/search/flex/index.js';

describe('FlexSearchGraph', () => {
    it('emits abstract factor edges without packed rank identity', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const selections = new RankSelectionStore();
        const graph = new FlexSearchGraph(kernel, kernel.getPool(30), selections);
        const root = graph.getRootNodeId(30);
        const expansion = graph.getExpansion(root);

        assert.ok(expansion.edges.length > 0);
        for (const edge of expansion.edges) {
            const factor = selections.getFactor(edge.factorId);
            assert.ok(factor.alternatives.length > 0);
            for (const alternative of factor.alternatives) {
                assert.ok(alternative.enchantId >= 0);
                assert.ok(alternative.enchantId < 256);
            }
        }
    });
});

describe('FlexSearchRun', () => {
    it('seeds exact rank pools into shared Flex rank-merge graphs', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const currentRun = new FlexSearchRun(kernel);
        currentRun.seedXp(30);
        const currentStats = currentRun.getMemoryStats();

        assert.ok(currentStats.graphCount > 0);
        assert.ok(currentStats.rankPoolCount > currentStats.graphCount);
        assert.strictEqual(currentStats.pendingCount, currentRun.getPendingEntries().length);
        assert.strictEqual(currentStats.pendingMass, currentStats.seededMass);
        assert.strictEqual(currentStats.resolvedMass, 0n);
        assertMassConserved(currentRun);
    });

    it('keeps initial frontier identity free of rank-pool mix identity', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new FlexSearchRun(kernel);
        run.seedXp(30);

        for (const entry of run.getPendingEntries()) {
            const graph = run.getGraph(entry.graphId);
            const node = graph.getNode(entry.nodeId);
            assert.strictEqual(entry.factorSetId, run.selections.emptyFactorSet);
            assert.strictEqual(node.count, 0);
            assert.ok(run.selections.getRankPoolMix(entry.rankPoolMixId).totalWeight > 0n);
        }
    });

    it('keeps roots separate, then merges after root expansion creates child lanes', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new FlexSearchRun(kernel);
        run.seedXp(30);
        const rootCount = run.getPendingEntries().length;

        assert.ok(rootCount > 1);
        assert.strictEqual(run.getMemoryStats().pendingMergeCount, 0);

        run.advance(rootCount);
        const stats = run.getMemoryStats();
        assert.ok(stats.pendingMergeCount > 0, 'child lanes should merge once root expansion moves past roots');
        assert.ok(run.getPendingEntries().some(entry => entry.factorSetId !== run.selections.emptyFactorSet));
        assertMassConserved(run);
    });

    it('records resolved mass while advancing terminal and stopped entries', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new FlexSearchRun(kernel);
        run.seedXp(1);

        for (let steps = 0; steps < 200 && run.getResolvedEntries().size === 0; steps++) {
            run.advance(1);
        }

        assert.ok(run.getMemoryStats().iterations > 0);
        assert.ok(run.getResolvedEntries().size > 0);
        for (const mass of run.getResolvedEntries().values()) {
            assert.ok(mass > 0n);
        }
        assertMassConserved(run);
    });

    it('conserves rank-pool payload mass during repeated frontier advances', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new FlexSearchRun(kernel);
        run.seedXp(30);

        assertMassConserved(run);
        for (let steps = 0; steps < 1000; steps++) {
            assert.strictEqual(run.advance(1), 1);
            if (steps % 25 === 0) assertMassConserved(run);
        }

        const stats = run.getMemoryStats();
        assert.ok(stats.pendingMergeCount > 0);
        assert.ok(stats.resolvedMass > 0n);
        assertMassConserved(run);
    });

    it('replays reopened frontier keys through cached structural expansions', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const run = new FlexSearchRun(kernel);
        run.seedXp(30);

        while (run.getPendingEntries().length > 0) {
            assert.strictEqual(run.advance(1), 1);
        }

        const stats = run.getMemoryStats();
        const expansionBuilds = stats.graphs.reduce((sum, graph) => sum + graph.expansionBuildCount, 0);
        assert.ok(stats.lateForwardCount > 0);
        assert.strictEqual(stats.iterations, expansionBuilds);
        assertMassConserved(run);
    });

    it('projects tiny exhaustive sword results from the current Flex path', () => {
        const projected = projectExhaustive('1.21.11', 'sword', 'diamond', 1);

        assert.strictEqual(projected.pendingCount, 0);
        assert.strictEqual(projected.massConserved, true);
        assert.ok(projected.results.size > 0);
        assert.strictEqual(projected.sourceMass, projected.projectedMass + projected.projectionLoss + projected.clueIncompatible);
    });

    it('projects tiny exhaustive book results from the current Flex path', () => {
        const projected = projectExhaustive('1.21.11', 'book', 'book', 1);

        assert.strictEqual(projected.pendingCount, 0);
        assert.strictEqual(projected.massConserved, true);
        assert.ok(projected.results.size > 0);
        assert.strictEqual(projected.sourceMass, projected.projectedMass + projected.projectionLoss + projected.clueIncompatible);
    });

    it('projects the modern sword exhaustive row set from the current Flex path', () => {
        const projected = projectExhaustive('1.21.11', 'sword', 'diamond', 30);

        assert.strictEqual(projected.pendingCount, 0);
        assert.strictEqual(projected.massConserved, true);
        assert.strictEqual(projected.results.size, 415);
        assert.strictEqual(projected.sourceMass, projected.projectedMass + projected.projectionLoss + projected.clueIncompatible);
    });

    it('projects the old-book exhaustive row set from the current Flex path', () => {
        const projected = projectExhaustive('1.7.2', 'book', 'book', 30);

        assert.strictEqual(projected.pendingCount, 0);
        assert.strictEqual(projected.massConserved, true);
        assert.strictEqual(projected.results.size, 118_384);
        assert.strictEqual(projected.sourceMass, projected.projectedMass + projected.projectionLoss + projected.clueIncompatible);
    });

    it('projects exact clue-conditioned rows from the current Flex path', () => {
        const projected = projectExhaustive('1.21.11', 'sword', 'diamond', 30, 'Sharpness', 4);

        assert.strictEqual(projected.pendingCount, 0);
        assert.strictEqual(projected.massConserved, true);
        assert.strictEqual(projected.results.size, 32);
        assert.ok(projected.clueIncompatible > 0n);
        assert.strictEqual(projected.sourceMass, projected.projectedMass + projected.projectionLoss + projected.clueIncompatible);
    });
});

function assertMassConserved(run: FlexSearchRun): void {
    const stats = run.getMemoryStats();
    assert.strictEqual(stats.pendingMass + stats.resolvedMass + stats.overflowMass + stats.roundingLoss, stats.seededMass);

    for (const entry of run.getPendingEntries()) {
        assert.strictEqual(run.selections.getRankPoolMix(entry.rankPoolMixId).totalWeight, entry.mass);
    }

    for (const [selectionId, mass] of run.getResolvedEntries()) {
        const selection = run.selections.getSelection(selectionId);
        assert.strictEqual(run.selections.getRankPoolMix(selection.rankPoolMixId).totalWeight, mass);
    }
}

function projectExhaustive(
    version: string,
    item: string,
    material: string,
    xp: number,
    clueName?: string,
    clueRank?: number
): FlexSearchProjection {
    const registry = RegistryFactory.build(version);
    const kernel = new RegistryKernel({ registry, item, material });
    const targetClueId = clueName === undefined || clueRank === undefined
        ? undefined
        : ((registry.idMap.get(clueName)! << 8) | clueRank);

    const currentRun = new FlexSearchRun(kernel);
    currentRun.seedXp(xp);
    for (let steps = 0; steps < 100_000 && currentRun.getPendingEntries().length > 0;) {
        const advanced = currentRun.advance(10_000);
        steps += advanced;
        if (advanced === 0) break;
    }

    assert.strictEqual(currentRun.getPendingEntries().length, 0);
    assertMassConserved(currentRun);

    const projector = new FlexSearchProjector(
        currentRun.rankPools,
        currentRun.selections,
        registry.enchantToIndex,
        { applyBookRemoval: item === 'book', targetClueId }
    );
    const projected = projector.projectResults(currentRun.getResolvedEntries());
    const memory = currentRun.getMemoryStats();

    return {
        results: projected.results,
        sourceMass: projected.sourceMass,
        projectedMass: projected.projectedMass,
        projectionLoss: projected.projectionLoss,
        clueIncompatible: projected.clueIncompatible,
        pendingCount: currentRun.getPendingEntries().length,
        massConserved: memory.pendingMass + memory.resolvedMass + memory.overflowMass + memory.roundingLoss === memory.seededMass
    };
}

interface FlexSearchProjection {
    readonly results: ReadonlyMap<number, bigint>;
    readonly sourceMass: bigint;
    readonly projectedMass: bigint;
    readonly projectionLoss: bigint;
    readonly clueIncompatible: bigint;
    readonly pendingCount: number;
    readonly massConserved: boolean;
}
