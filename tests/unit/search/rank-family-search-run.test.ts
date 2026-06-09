import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RegistryFactory } from '#core/factory.js';
import { RegistryKernel } from '#lib/search/index.js';
import {
    GroupedFlexSearchRun,
    RankFamilyGraph,
    RankFamilySearchRun,
    RankSelectionStore
} from '#lib/search/flex/index.js';

describe('RankFamilyGraph', () => {
    it('emits abstract factor edges without packed rank identity', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const selections = new RankSelectionStore();
        const graph = new RankFamilyGraph(kernel, kernel.getPool(30), selections);
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

describe('RankFamilySearchRun', () => {
    it('seeds exact rank pools into fewer rank-family graphs than the current exact-pool runtime', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const exactRun = new GroupedFlexSearchRun(kernel);
        exactRun.seedXp(30);

        const rankRun = new RankFamilySearchRun(kernel);
        rankRun.seedXp(30);
        const rankStats = rankRun.getMemoryStats();

        assert.ok(rankStats.graphCount > 0);
        assert.ok(rankStats.rankPoolCount > rankStats.graphCount);
        assert.ok(rankStats.graphCount < exactRun.getMemoryStats().graphs.length);
        assert.strictEqual(rankStats.pendingCount, rankRun.getPendingEntries().length);
        assert.strictEqual(rankStats.pendingMass, rankStats.seededMass);
        assert.strictEqual(rankStats.resolvedMass, 0n);
        assertMassConserved(rankRun);
    });

    it('keeps initial frontier identity free of rank-pool mix identity', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new RankFamilySearchRun(kernel);
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
        const run = new RankFamilySearchRun(kernel);
        run.seedXp(30);
        const rootCount = run.getPendingEntries().length;

        assert.ok(rootCount > 1);
        assert.strictEqual(run.getMemoryStats().pendingMergeCount, 0);

        run.advance(rootCount);
        const stats = run.getMemoryStats();
        assert.ok(stats.pendingMergeCount > 0, 'child lanes should merge once root expansion moves past roots');
        assert.ok(run.getPendingEntries().some(entry => entry.factorSetId !== run.selections.emptyFactorSet));
        assert.strictEqual(stats.roundingLoss, 0n);
        assertMassConserved(run);
    });

    it('records resolved mass while advancing terminal and stopped entries', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new RankFamilySearchRun(kernel);
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
        const run = new RankFamilySearchRun(kernel);
        run.seedXp(30);

        assertMassConserved(run);
        for (let steps = 0; steps < 1000; steps++) {
            assert.strictEqual(run.advance(1), 1);
            if (steps % 25 === 0) assertMassConserved(run);
        }

        const stats = run.getMemoryStats();
        assert.ok(stats.pendingMergeCount > 0);
        assert.ok(stats.resolvedMass > 0n);
        assert.strictEqual(stats.roundingLoss, 0n);
        assertMassConserved(run);
    });
});

function assertMassConserved(run: RankFamilySearchRun): void {
    const stats = run.getMemoryStats();
    assert.strictEqual(stats.pendingMass + stats.resolvedMass + stats.roundingLoss, stats.seededMass);

    for (const entry of run.getPendingEntries()) {
        assert.strictEqual(run.selections.getRankPoolMix(entry.rankPoolMixId).totalWeight, entry.mass);
    }

    for (const [selectionId, mass] of run.getResolvedEntries()) {
        const selection = run.selections.getSelection(selectionId);
        assert.strictEqual(run.selections.getRankPoolMix(selection.rankPoolMixId).totalWeight, mass);
    }
}
