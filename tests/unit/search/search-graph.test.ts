import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory, RegistryKernel, SearchGraph } from '#lib/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';

describe('SearchGraph', () => {
    it('lazily expands root nodes into canonical one-enchant children', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const pool = kernel.getPool(30);
        const graph = new SearchGraph(kernel, pool);
        const root = graph.getRootNode(30);

        assert.strictEqual(graph.size, 1);
        const expansion = graph.getExpansion(root.id);

        assert.strictEqual(expansion.isRoot, true);
        assert.strictEqual(expansion.totalWeight, pool.totalWeight);
        assert.strictEqual(expansion.edges.length, pool.entries.length);
        assert.strictEqual(graph.size, pool.entries.length + 1);
        assert.strictEqual(graph.getExpansion(root.id), expansion, 'expansion should be cached');

        const firstEdge = expansion.edges[0]!;
        const child = graph.getNode(firstEdge.childId);
        assert.strictEqual(child.selectedMask, firstEdge.entry.idBit);
        assert.strictEqual(child.currentLevel, 30);
        assert.strictEqual(child.count, 1);
    });

    it('merges converged children from adjacent roots with the same pool signature', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const levels = Array.from({ length: 50 }, (_, i) => i + 1);
        const group = kernel.groupLevelsByPoolSignature(levels).find(candidate => {
            const sorted = [...candidate.levels].sort((a, b) => a - b);
            return sorted.some((level, index) => sorted[index + 1] === level + 1 && Math.floor(level / 2) === Math.floor((level + 1) / 2));
        });

        assert.ok(group, 'fixture should have adjacent equivalent pool levels');
        const sorted = [...group.levels].sort((a, b) => a - b);
        const low = sorted.find((level, index) => sorted[index + 1] === level + 1 && Math.floor(level / 2) === Math.floor((level + 1) / 2));
        assert.notStrictEqual(low, undefined);
        const high = low! + 1;

        const graph = new SearchGraph(kernel, group.pool);
        const lowFirst = graph.getExpansion(graph.getRootNode(low!).id).edges[0]!;
        const highFirst = graph.getExpansion(graph.getRootNode(high).id).edges[0]!;
        assert.notStrictEqual(lowFirst.childId, highFirst.childId, 'one-enchant nodes keep their original current level');

        const lowExpansion = graph.getExpansion(lowFirst.childId);
        const highExpansion = graph.getExpansion(highFirst.childId);
        assert.strictEqual(lowExpansion.edges.length, highExpansion.edges.length);

        const lowChildrenByEnchant = new Map(lowExpansion.edges.map(edge => [edge.entry.enchantId, edge.childId]));
        for (const edge of highExpansion.edges) {
            assert.strictEqual(
                lowChildrenByEnchant.get(edge.entry.enchantId),
                edge.childId,
                `child for enchant ${edge.entry.enchantId} should converge after halving`
            );
        }
    });

    it('marks max-enchant nodes as terminal structural nodes', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const graph = new SearchGraph(kernel, kernel.getPool(30));
        let node = graph.getRootNode(30);

        for (let count = 0; count < ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM; count++) {
            const expansion = graph.getExpansion(node.id);
            const next = expansion.edges[0];
            assert.ok(next, `expected an edge at count ${count}`);
            node = graph.getNode(next.childId);
        }

        const terminal = graph.getExpansion(node.id);
        assert.strictEqual(terminal.terminalReason, 'max-enchants');
        assert.strictEqual(terminal.edges.length, 0);
    });
});
