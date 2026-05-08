import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BIGINT_CONSTANTS } from '#constants/engine.js';
import { SearchProcessor } from '#engine/search/SearchProcessor.js';
import { NodeIdSearchFrontier } from '#engine/search/NodeIdSearchFrontier.js';
import { SearchNodeGraph } from '#engine/search/SearchNodeGraph.js';
import { SearchPoolPlan } from '#engine/search/SearchPoolPlan.js';
import { ComboUtils } from '#utils/index.js';
import { ForwardingContext, PackedCombo, PackedEnchant } from '#types/index.js';

function makeEnchant(id: number): PackedEnchant {
    return ((id << 8) | 1) as PackedEnchant;
}

const enchantA = makeEnchant(1);
const enchantB = makeEnchant(2);
const enchantHigh = makeEnchant(36);

function makeRegistryWithIds(ids: number[]): any {
    const maxId = Math.max(0, ...ids);
    const registry = {
        multiEnchantBooks: true,
        conflictBitsets: new BigUint64Array(maxId + 1),
        idMap: new Map<string, number>(),
        enchantToIndex: new Map<number, number>(),
        indexToEnchant: [0],
        weightMap: new Uint32Array(maxId + 1),
    } as any;

    ids.forEach((id, index) => {
        const enchant = makeEnchant(id);
        registry.idMap.set(`enchant-${id}`, id);
        registry.enchantToIndex.set(enchant, index + 1);
        registry.indexToEnchant[index + 1] = enchant;
        registry.weightMap[id] = 1;
    });

    return registry;
}

function makeContext(graph: SearchNodeGraph): ForwardingContext {
    const registry = {
            multiEnchantBooks: true,
            conflictBitsets: new BigUint64Array(64),
            idMap: new Map<string, number>([
                ['a', 1],
                ['b', 2]
            ]),
            enchantToIndex: new Map<number, number>([
                [enchantA, 1],
                [enchantB, 2]
            ]),
            indexToEnchant: [0, enchantA, enchantB],
            weightMap: new Uint32Array(64),
        } as any;
    registry.weightMap[1] = 1;
    registry.weightMap[2] = 1;

    return {
        registry,
        results: new Map(),
        queue: new NodeIdSearchFrontier(),
        graph,
        resultsLimit: 100,
        item: 'sword',
        poolPlan: new SearchPoolPlan(registry, [enchantA, enchantB], 30)
    };
}

function makeHighIdContext(graph: SearchNodeGraph, highId = 36): ForwardingContext {
    const highEnchant = makeEnchant(highId);
    const maxId = Math.max(64, highId + 1);
    const registry = {
            multiEnchantBooks: true,
            conflictBitsets: new BigUint64Array(maxId),
            idMap: new Map<string, number>([
                ['a', 1],
                ['high', highId]
            ]),
            enchantToIndex: new Map<number, number>([
                [enchantA, 1],
                [highEnchant, 2]
            ]),
            indexToEnchant: [0, enchantA, highEnchant],
            weightMap: new Uint32Array(maxId),
        } as any;
    registry.conflictBitsets[1] = 1n << BigInt(highId);
    registry.weightMap[1] = 1;
    registry.weightMap[highId] = 1;

    return {
        registry,
        results: new Map(),
        queue: new NodeIdSearchFrontier(),
        graph,
        resultsLimit: 100,
        item: 'sword',
        poolPlan: new SearchPoolPlan(registry, [enchantA, highEnchant], 30)
    };
}

describe('SearchNodeGraph', () => {
    it('selects the number53 identity mode through ID 44', () => {
        const registry = makeRegistryWithIds([44]);
        const plan = new SearchPoolPlan(registry, [makeEnchant(44)], 30);

        assert.strictEqual(plan.identityMode, 'number53');
    });

    it('selects the BigInt64 identity mode starting at ID 45', () => {
        const registry = makeRegistryWithIds([45]);
        const plan = new SearchPoolPlan(registry, [makeEnchant(45)], 30);
        const graph = new SearchNodeGraph();
        const meta = ((1n << 45n) << 8n) | 30n;

        const nodeA = graph.getOrCreateNode(meta, 1 as PackedCombo, 1);
        const nodeB = graph.getOrCreateNode(meta, 2 as PackedCombo, 2);

        assert.strictEqual(plan.identityMode, 'bigint64');
        assert.strictEqual(nodeA, nodeB);
        assert.strictEqual(graph.isNumericNode(nodeA), false);
        assert.strictEqual(graph.getMeta(nodeA), meta);
    });

    it('rejects registries beyond the 64-enchant identity range', () => {
        const registry = makeRegistryWithIds([64]);

        assert.throws(
            () => new SearchPoolPlan(registry, [makeEnchant(64)], 30),
            /supports enchant IDs 0-63/
        );
    });

    it('deduplicates canonical nodes reached through different enchant orderings', () => {
        const graph = new SearchNodeGraph();
        const ctx = makeContext(graph);
        const levelBits = BIGINT_CONSTANTS.LEVEL_LOOKUP[30]!;

        const metaA = (BIGINT_CONSTANTS.ID_BIT_LOOKUP[1]! << BIGINT_CONSTANTS.ENCHANT_SHIFT) | levelBits;
        const metaB = (BIGINT_CONSTANTS.ID_BIT_LOOKUP[2]! << BIGINT_CONSTANTS.ENCHANT_SHIFT) | levelBits;
        const comboA = ComboUtils.pack([enchantA], ctx.registry.enchantToIndex) as PackedCombo;
        const comboB = ComboUtils.pack([enchantB], ctx.registry.enchantToIndex) as PackedCombo;
        const nodeA = graph.getOrCreateNode(metaA, comboA, 1);
        const nodeB = graph.getOrCreateNode(metaB, comboB, 1);

        const fromA = SearchProcessor.buildExpansionBlueprint(nodeA, ctx);
        const fromB = SearchProcessor.buildExpansionBlueprint(nodeB, ctx);

        assert.strictEqual(fromA.eligibleCount, 1);
        assert.strictEqual(fromB.eligibleCount, 1);
        const childFromA = graph.getEdgeChildId(fromA.edgeStart);
        const childFromB = graph.getEdgeChildId(fromB.edgeStart);
        assert.strictEqual(childFromA, childFromB);
        assert.strictEqual(graph.getCombo(childFromA), graph.getCombo(childFromB));
    });

    it('deduplicates numeric nodes with enchant IDs above 31', () => {
        const graph = new SearchNodeGraph();
        const highMaskHi = 2 ** (36 - 32);
        const combo = ComboUtils.pack([enchantHigh], new Map<number, number>([[enchantHigh, 1]])) as PackedCombo;

        const numericNode = graph.getOrCreateNumericNode(0, highMaskHi, 30, combo, 1);
        const meta = ((1n << 36n) << 8n) | 30n;
        const bigintNode = graph.getOrCreateNode(meta, combo, 1);

        assert.strictEqual(numericNode, bigintNode);
        assert.strictEqual(graph.getMeta(numericNode), meta);
        assert.strictEqual(graph.getMaskLo(numericNode), 0);
        assert.strictEqual(graph.getMaskHi(numericNode), highMaskHi);
        assert.strictEqual(graph.getLevel(numericNode), 30);
    });

    it('finds existing numeric nodes without changing their stored combo', () => {
        const graph = new SearchNodeGraph();
        const highMaskHi = 2 ** (36 - 32);
        const originalCombo = 17 as PackedCombo;
        const ignoredCombo = 23 as PackedCombo;

        const nodeId = graph.createNumericNode(0, highMaskHi, 30, originalCombo, 1);

        assert.strictEqual(graph.getNumericNodeId(0, highMaskHi, 30), nodeId);
        assert.strictEqual(graph.getOrCreateNumericNode(0, highMaskHi, 30, ignoredCombo, 2), nodeId);
        assert.strictEqual(graph.getCombo(nodeId), originalCombo);
        assert.strictEqual(graph.getCount(nodeId), 1);
    });

    it('uses split masks for selected and conflicting high-id enchants', () => {
        const graph = new SearchNodeGraph();
        const ctx = makeHighIdContext(graph);
        const highMaskHi = 2 ** (36 - 32);
        const combo = ComboUtils.pack([enchantHigh], ctx.registry.enchantToIndex) as PackedCombo;
        const nodeId = graph.getOrCreateNumericNode(0, highMaskHi, 30, combo, 1);

        const blueprint = SearchProcessor.buildExpansionBlueprint(nodeId, ctx);

        assert.strictEqual(blueprint.eligibleCount, 0);
    });

    it('uses BigInt64 selected and conflict checks at the top supported ID', () => {
        const graph = new SearchNodeGraph();
        const ctx = makeHighIdContext(graph, 63);
        const combo = ComboUtils.pack([makeEnchant(63)], ctx.registry.enchantToIndex) as PackedCombo;
        const meta = ((1n << 63n) << 8n) | 30n;
        const nodeId = graph.getOrCreateNode(meta, combo, 1);

        const blueprint = SearchProcessor.buildExpansionBlueprint(nodeId, ctx);

        assert.strictEqual(ctx.poolPlan.identityMode, 'bigint64');
        assert.strictEqual(graph.isNumericNode(nodeId), false);
        assert.strictEqual(blueprint.eligibleCount, 0);
    });

    it('keeps BigInt fallback identity for metas beyond the numeric-safe range', () => {
        const graph = new SearchNodeGraph();
        const meta = ((1n << 60n) << 8n) | 7n;

        const nodeA = graph.getOrCreateNode(meta, 1 as PackedCombo, 1);
        const nodeB = graph.getOrCreateNode(meta, 2 as PackedCombo, 2);

        assert.strictEqual(nodeA, nodeB);
        assert.strictEqual(graph.isNumericNode(nodeA), false);
        assert.strictEqual(graph.getMeta(nodeA), meta);
    });

    it('clones blueprint and residue state independently', () => {
        const graph = new SearchNodeGraph();
        const nodeId = graph.getOrCreateNode(1n, 1 as PackedCombo, 1);
        const childId = graph.getOrCreateNode(2n, 2 as PackedCombo, 2);
        const edgeStart = graph.beginEdgeSpan();
        graph.appendBlueprintEdge(childId, 1);
        graph.setBlueprint(nodeId, {
            probContinue: 1n,
            totalWeight: 1,
            eligibleCount: 1,
            edgeStart,
            currentCount: 1,
            currentCombo: 1 as PackedCombo
        });
        graph.getForwardingResidue(nodeId).residue = 7n;

        const clone = graph.clone();
        clone.getForwardingResidue(nodeId).residue = 11n;

        assert.strictEqual(graph.getForwardingResidue(nodeId).residue, 7n);
        assert.strictEqual(clone.getForwardingResidue(nodeId).residue, 11n);
        assert.deepStrictEqual(clone.getBlueprint(nodeId), graph.getBlueprint(nodeId));
        assert.strictEqual(clone.getEdgeChildId(edgeStart), childId);
    });
});
