import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EMPTY_PLEX_PAYLOAD, createPlexPayload } from '#lib/search/plex/PlexPayload.js';
import { PlexRunFrontier, type PlexFrontierPopTarget } from '#lib/search/plex/PlexRunFrontier.js';
import type { PlexNodeId } from '#lib/search/plex/PlexGraph.js';
import type { PackedEnchant } from '#types/index.js';

const packed = (value: number) => value as PackedEnchant;

function pop(frontier: PlexRunFrontier): PlexFrontierPopTarget {
    const out: PlexFrontierPopTarget = {
        graphId: -1,
        nodeId: -1 as PlexNodeId,
        mass: 0n,
        payload: EMPTY_PLEX_PAYLOAD
    };
    assert.strictEqual(frontier.pop(out), true);
    return out;
}

describe('PlexRunFrontier', () => {
    it('pops largest pending mass first', () => {
        const frontier = new PlexRunFrontier();

        frontier.pushOrMerge(0, 1 as PlexNodeId, 5n, EMPTY_PLEX_PAYLOAD);
        frontier.pushOrMerge(0, 2 as PlexNodeId, 9n, EMPTY_PLEX_PAYLOAD);
        frontier.pushOrMerge(0, 3 as PlexNodeId, 1n, EMPTY_PLEX_PAYLOAD);

        assert.strictEqual(frontier.size, 3);
        assert.strictEqual(frontier.peekMass(), 9n);
        assert.deepStrictEqual(
            [pop(frontier).mass, pop(frontier).mass, pop(frontier).mass],
            [9n, 5n, 1n]
        );
        assert.strictEqual(frontier.pop({ graphId: 0, nodeId: 0 as PlexNodeId, mass: 0n, payload: EMPTY_PLEX_PAYLOAD }), false);
    });

    it('merges identical graph/node/payload states', () => {
        const frontier = new PlexRunFrontier();
        const payload = createPlexPayload([packed(42)]);

        frontier.pushOrMerge(7, 11 as PlexNodeId, 5n, payload);
        frontier.pushOrMerge(7, 11 as PlexNodeId, 8n, payload);

        assert.strictEqual(frontier.size, 1);
        assert.strictEqual(frontier.peekMass(), 13n);
        const entry = pop(frontier);
        assert.strictEqual(entry.graphId, 7);
        assert.strictEqual(entry.nodeId, 11);
        assert.strictEqual(entry.mass, 13n);
        assert.strictEqual(entry.payload, payload);
    });

    it('rejects different payloads for the same graph and node', () => {
        const frontier = new PlexRunFrontier();
        const left = createPlexPayload([packed(1)]);
        const right = createPlexPayload([packed(2)]);

        frontier.pushOrMerge(0, 1 as PlexNodeId, 5n, left);

        assert.throws(
            () => frontier.pushOrMerge(0, 1 as PlexNodeId, 7n, right),
            /received payload/
        );
        assert.strictEqual(frontier.size, 1);
        assert.strictEqual(pop(frontier).payload, left);
    });
});
