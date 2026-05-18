import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory, RegistryKernel } from '#lib/index.js';
import { SuperpositionSearchGraph } from '#lib/search/superposition/SuperpositionSearchGraph.js';

describe('SuperpositionSearchGraph', () => {
    it('keys structural nodes by exclusion mask, current level, and count', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const graph = new SuperpositionSearchGraph(kernel, kernel.getPool(30));

        const first = graph.getOrCreateNode(1n, 15, 1);
        const duplicate = graph.getOrCreateNode(1n, 15, 1);
        const differentCount = graph.getOrCreateNode(1n, 15, 2);
        const differentLevel = graph.getOrCreateNode(1n, 14, 1);
        const differentMask = graph.getOrCreateNode(3n, 15, 1);

        assert.strictEqual(first.id, duplicate.id);
        assert.notStrictEqual(first.id, differentCount.id);
        assert.notStrictEqual(first.id, differentLevel.id);
        assert.notStrictEqual(first.id, differentMask.id);
        assert.strictEqual(graph.size, 4);
    });

    it('keeps roots distinct per modified level while using empty exclusion state', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const graph = new SuperpositionSearchGraph(kernel, kernel.getPool(30));

        const low = graph.getRootNode(29);
        const high = graph.getRootNode(30);
        const repeatedHigh = graph.getRootNode(30);

        assert.strictEqual(high.id, repeatedHigh.id);
        assert.notStrictEqual(low.id, high.id);
        assert.strictEqual(high.exclusionMask, 0n);
        assert.strictEqual(high.count, 0);
    });
});
