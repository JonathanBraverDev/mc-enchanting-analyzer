import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BIGINT_CONSTANTS } from '#constants/engine.js';
import { SearchProcessor } from '#engine/search/SearchProcessor.js';
import { NodeIdSearchFrontier } from '#engine/search/NodeIdSearchFrontier.js';
import { SearchNodeGraph } from '#engine/search/SearchNodeGraph.js';
import { ComboUtils } from '#utils/index.js';
import { ForwardingContext, PackedCombo, PackedEnchant } from '#types/index.js';

const enchantA = ((1 << 8) | 1) as PackedEnchant;
const enchantB = ((2 << 8) | 1) as PackedEnchant;

function makeContext(graph: SearchNodeGraph): ForwardingContext {
    return {
        registry: {
            multiEnchantBooks: true,
            conflictBitsets: new BigUint64Array(64),
            enchantToIndex: new Map<number, number>([
                [enchantA, 1],
                [enchantB, 2]
            ]),
            indexToEnchant: [0, enchantA, enchantB],
            weightMap: new Uint32Array(64),
        } as any,
        results: new Map(),
        queue: new NodeIdSearchFrontier(),
        graph,
        resultsLimit: 100,
        cat: 'sword',
        pool: [enchantA, enchantB],
        poolWeights: [1, 1],
        initialTotalWeight: 2
    };
}

describe('SearchNodeGraph', () => {
    it('deduplicates canonical nodes reached through different enchant orderings', () => {
        const graph = new SearchNodeGraph();
        const ctx = makeContext(graph);
        const levelBits = BIGINT_CONSTANTS.LEVEL_LOOKUP[30]!;

        const metaA = (BIGINT_CONSTANTS.ID_BIT_LOOKUP[1]! << BIGINT_CONSTANTS.ENCHANT_SHIFT) | levelBits;
        const metaB = (BIGINT_CONSTANTS.ID_BIT_LOOKUP[2]! << BIGINT_CONSTANTS.ENCHANT_SHIFT) | levelBits;
        const comboA = ComboUtils.pack([enchantA], ctx.registry.enchantToIndex) as PackedCombo;
        const comboB = ComboUtils.pack([enchantB], ctx.registry.enchantToIndex) as PackedCombo;
        graph.getOrCreateNode(metaA, comboA, 1);
        graph.getOrCreateNode(metaB, comboB, 1);

        const fromA = SearchProcessor.buildExpansionBlueprint(metaA, comboA, 1, ctx);
        const fromB = SearchProcessor.buildExpansionBlueprint(metaB, comboB, 1, ctx);

        assert.strictEqual(fromA.childIds.length, 1);
        assert.strictEqual(fromB.childIds.length, 1);
        assert.strictEqual(fromA.childIds[0], fromB.childIds[0]);
        assert.strictEqual(graph.getCombo(fromA.childIds[0]!), graph.getCombo(fromB.childIds[0]!));
    });

    it('clones blueprint and residue state independently', () => {
        const graph = new SearchNodeGraph();
        const nodeId = graph.getOrCreateNode(1n, 1 as PackedCombo, 1);
        const childId = graph.getOrCreateNode(2n, 2 as PackedCombo, 2);
        graph.setBlueprint(nodeId, {
            probContinue: 1n,
            totalWeight: 1,
            eligibleCount: 1,
            eligibleEnchants: [enchantB],
            eligibleWeights: new Int32Array([1]),
            childIds: new Uint32Array([childId]),
            nextLevel: 1,
            currentCount: 1,
            currentCombo: 1 as PackedCombo,
            currentEnchants: []
        });
        graph.getForwardingResidue(nodeId).residue = 7n;

        const clone = graph.clone();
        clone.getForwardingResidue(nodeId).residue = 11n;

        assert.strictEqual(graph.getForwardingResidue(nodeId).residue, 7n);
        assert.strictEqual(clone.getForwardingResidue(nodeId).residue, 11n);
        assert.deepStrictEqual(clone.getBlueprint(nodeId), graph.getBlueprint(nodeId));
    });
});
