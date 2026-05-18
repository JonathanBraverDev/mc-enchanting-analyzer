import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory, RegistryKernel } from '#lib/index.js';
import type { PackedEnchant } from '#types/index.js';
import { ComboUtils } from '#utils/index.js';
import {
    appendPlexPayloadEdge,
    createPlexPayload,
    EMPTY_PLEX_PAYLOAD,
    materializePlexPayloadFactors
} from '#lib/search/plex/PlexPayload.js';
import { PlexGraph } from '#lib/search/plex/PlexGraph.js';

const packed = (value: number): PackedEnchant => value as PackedEnchant;

describe('PlexPayload', () => {
    it('materializes the empty payload as one neutral factor', () => {
        const registry = RegistryFactory.build('1.21.11');
        const factors = materializePlexPayloadFactors(EMPTY_PLEX_PAYLOAD, registry.enchantToIndex);

        assert.deepStrictEqual(factors, [{ combo: 0, numerator: 1n, denominator: 1n }]);
    });

    it('keeps choice weights aligned with canonical choice ordering', () => {
        const payload = createPlexPayload(
            [packed(7)],
            [[packed(40), packed(30)], [packed(20), packed(10)]],
            [[4, 3], [2, 1]]
        );

        assert.deepStrictEqual(payload.combo.choices.map(choice => [...choice]), [[packed(10), packed(20)], [packed(30), packed(40)]]);
        assert.deepStrictEqual(payload.weights.map(weights => [...weights]), [[1, 2], [3, 4]]);
    });

    it('appends singleton edges as fixed picks and grouped edges as weighted choices', () => {
        const single = appendPlexPayloadEdge(EMPTY_PLEX_PAYLOAD, { alternatives: [packed(10)], weights: [5] });
        const grouped = appendPlexPayloadEdge(single, { alternatives: [packed(30), packed(20)], weights: [3, 2] });

        assert.deepStrictEqual([...grouped.combo.fixed], [packed(10)]);
        assert.deepStrictEqual(grouped.combo.choices.map(choice => [...choice]), [[packed(20), packed(30)]]);
        assert.deepStrictEqual(grouped.weights.map(weights => [...weights]), [[2, 3]]);
    });

    it('materializes weighted choice products as exact factors', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const entries = kernel.getPool(30).entries.map(entry => entry.packedEnchant);
        const fixed = entries[0]!;
        const left = [entries[1]!, entries[2]!];
        const right = [entries[3]!, entries[4]!];
        const payload = createPlexPayload([fixed], [right, left], [[7, 11], [2, 3]]);
        const factors = materializePlexPayloadFactors(payload, registry.enchantToIndex);

        assert.deepStrictEqual(factors, [
            { combo: ComboUtils.pack([fixed, left[0]!, right[0]!], registry.enchantToIndex), numerator: 2n * 7n, denominator: 5n * 18n },
            { combo: ComboUtils.pack([fixed, left[0]!, right[1]!], registry.enchantToIndex), numerator: 2n * 11n, denominator: 5n * 18n },
            { combo: ComboUtils.pack([fixed, left[1]!, right[0]!], registry.enchantToIndex), numerator: 3n * 7n, denominator: 5n * 18n },
            { combo: ComboUtils.pack([fixed, left[1]!, right[1]!], registry.enchantToIndex), numerator: 3n * 11n, denominator: 5n * 18n }
        ]);
    });

    it('preserves real PlexGraph grouped edge weights for future mass splitting', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const graph = new PlexGraph(kernel, kernel.getPool(30));
        const expansion = graph.getExpansion(graph.getRootNode(30).id);
        const groupedEdge = expansion.edges.find(edge => edge.alternatives.length >= 6);
        assert.ok(groupedEdge, 'fixture should expose a grouped damage edge');

        const payload = appendPlexPayloadEdge(EMPTY_PLEX_PAYLOAD, groupedEdge!);
        const factors = materializePlexPayloadFactors(payload, registry.enchantToIndex);
        const totalWeight = groupedEdge!.weights.reduce((sum, weight) => sum + weight, 0);

        assert.deepStrictEqual(payload.weights, [groupedEdge!.weights]);
        assert.strictEqual(factors.length, groupedEdge!.alternatives.length);
        assert.deepStrictEqual(
            factors.map(factor => factor.denominator),
            groupedEdge!.weights.map(() => BigInt(totalWeight))
        );
        assert.deepStrictEqual(
            factors.map(factor => factor.numerator),
            groupedEdge!.weights.map(weight => BigInt(weight))
        );
    });

    it('rejects mismatched edge alternatives and weights', () => {
        assert.throws(
            () => appendPlexPayloadEdge(EMPTY_PLEX_PAYLOAD, { alternatives: [packed(1), packed(2)], weights: [1] }),
            /same length/
        );
    });
});
