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
import { canonicalizeWeightedChoice } from '#lib/search/plex/PlexChoice.js';
import { PlexGraph } from '#lib/search/plex/PlexGraph.js';

const packed = (value: number): PackedEnchant => value as PackedEnchant;
const choice = (entries: readonly (readonly [PackedEnchant, number])[]) => canonicalizeWeightedChoice(
    entries.map(([packedEnchant, weight]) => ({ packedEnchant, weight }))
);
const weights = (payloadChoice: ReturnType<typeof choice>) => payloadChoice.alternatives.map(alternative => alternative.weight);

describe('PlexPayload', () => {
    it('materializes the empty payload as one neutral factor', () => {
        const registry = RegistryFactory.build('1.21.11');
        const factors = materializePlexPayloadFactors(EMPTY_PLEX_PAYLOAD, registry.enchantToIndex);

        assert.deepStrictEqual(factors, [{ combo: 0, numerator: 1n, denominator: 1n }]);
    });

    it('keeps choice weights aligned with canonical choice ordering', () => {
        const payload = createPlexPayload(
            [packed(7)],
            [
                choice([[packed(40), 4], [packed(30), 3]]),
                choice([[packed(20), 2], [packed(10), 1]])
            ]
        );

        assert.deepStrictEqual(payload.combo.choices.map(comboChoice => [...comboChoice]), [[packed(10), packed(20)], [packed(30), packed(40)]]);
        assert.deepStrictEqual(payload.choices.map(weights), [[1, 2], [3, 4]]);
    });

    it('appends singleton edges as fixed picks and grouped edges as weighted choices', () => {
        const single = appendPlexPayloadEdge(EMPTY_PLEX_PAYLOAD, { choice: choice([[packed(10), 5]]) });
        const grouped = appendPlexPayloadEdge(single, { choice: choice([[packed(30), 3], [packed(20), 2]]) });

        assert.deepStrictEqual([...grouped.combo.fixed], [packed(10)]);
        assert.deepStrictEqual(grouped.combo.choices.map(comboChoice => [...comboChoice]), [[packed(20), packed(30)]]);
        assert.deepStrictEqual(grouped.choices.map(weights), [[2, 3]]);
    });

    it('materializes weighted choice products as exact factors', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const entries = kernel.getPool(30).entries.map(entry => entry.packedEnchant);
        const fixed = entries[0]!;
        const left = [entries[1]!, entries[2]!];
        const right = [entries[3]!, entries[4]!];
        const payload = createPlexPayload([fixed], [
            choice([[right[0]!, 7], [right[1]!, 11]]),
            choice([[left[0]!, 2], [left[1]!, 3]])
        ]);
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
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const graph = new PlexGraph(kernel, kernel.getPool(30));
        const expansion = graph.getExpansion(graph.getRootNode(30).id);
        const groupedEdge = expansion.edges.find(edge => edge.choice.alternatives.length === 3);
        assert.ok(groupedEdge, 'fixture should expose a grouped damage edge');

        const payload = appendPlexPayloadEdge(EMPTY_PLEX_PAYLOAD, groupedEdge!);
        const factors = materializePlexPayloadFactors(payload, registry.enchantToIndex);

        assert.deepStrictEqual(payload.choices, [groupedEdge!.choice]);
        assert.deepStrictEqual(weights(groupedEdge!.choice), [10, 5, 5]);
        assert.strictEqual(factors.length, groupedEdge!.choice.alternatives.length);
        assert.deepStrictEqual(
            factors.map(factor => factor.denominator),
            [20n, 20n, 20n]
        );
        assert.deepStrictEqual(
            factors.map(factor => factor.numerator),
            [10n, 5n, 5n]
        );
    });

    it('rejects empty weighted choices', () => {
        assert.throws(() => canonicalizeWeightedChoice([]), /empty plex weighted choice/);
    });
});
