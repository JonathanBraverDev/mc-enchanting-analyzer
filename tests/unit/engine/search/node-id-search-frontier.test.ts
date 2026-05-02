import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NodeIdSearchFrontier } from '#engine/search/NodeIdSearchFrontier.js';

function drain(frontier: NodeIdSearchFrontier): Array<{ nodeId: number; prob: bigint }> {
    const out = { nodeId: 0, prob: 0n };
    const rows: Array<{ nodeId: number; prob: bigint }> = [];

    while (frontier.popFast(out)) {
        rows.push({ nodeId: out.nodeId, prob: out.prob });
    }

    return rows;
}

describe('NodeIdSearchFrontier', () => {
    it('pops nodes by descending probability', () => {
        const frontier = new NodeIdSearchFrontier(2);
        frontier.pushOrMerge(1, 10n);
        frontier.pushOrMerge(2, 5n);
        frontier.pushOrMerge(3, 20n);

        assert.deepStrictEqual(drain(frontier), [
            { nodeId: 3, prob: 20n },
            { nodeId: 1, prob: 10n },
            { nodeId: 2, prob: 5n }
        ]);
    });

    it('merges mass for an existing node ID', () => {
        const frontier = new NodeIdSearchFrontier(2);
        frontier.pushOrMerge(1, 5n);
        frontier.pushOrMerge(2, 10n);
        frontier.pushOrMerge(1, 20n);

        assert.strictEqual(frontier.size(), 2);
        assert.deepStrictEqual(drain(frontier), [
            { nodeId: 1, prob: 25n },
            { nodeId: 2, prob: 10n }
        ]);
    });

    it('grows for sparse node IDs', () => {
        const frontier = new NodeIdSearchFrontier(1);
        frontier.pushOrMerge(4096, 7n);

        const out = { nodeId: 0, prob: 0n };
        assert.strictEqual(frontier.popFast(out), true);
        assert.deepStrictEqual(out, { nodeId: 4096, prob: 7n });
    });

    it('clones independently', () => {
        const frontier = new NodeIdSearchFrontier(2);
        frontier.pushOrMerge(1, 10n);
        frontier.pushOrMerge(2, 5n);

        const clone = frontier.clone();
        clone.pushOrMerge(3, 100n);

        assert.deepStrictEqual(drain(frontier), [
            { nodeId: 1, prob: 10n },
            { nodeId: 2, prob: 5n }
        ]);
        assert.deepStrictEqual(drain(clone), [
            { nodeId: 3, prob: 100n },
            { nodeId: 1, prob: 10n },
            { nodeId: 2, prob: 5n }
        ]);
    });
});
