import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory, RegistryKernel } from '#lib/index.js';
import type { PackedEnchant } from '#types/index.js';
import { ComboUtils } from '#utils/index.js';
import {
    appendPlexEdge,
    createPlexCombo,
    EMPTY_PLEX_COMBO,
    getPlexSlotCount,
    isConcretePlexCombo,
    materializePlexCombo,
    samePlexCombo
} from '#lib/search/plex/PlexCombo.js';
import { PlexGraph } from '#lib/search/plex/PlexGraph.js';
import { canonicalizeWeightedChoice, getPlexChoicePackedEnchants } from '#lib/search/plex/PlexChoice.js';

const packed = (value: number): PackedEnchant => value as PackedEnchant;
const choice = (alternatives: readonly PackedEnchant[]) => canonicalizeWeightedChoice(
    alternatives.map(packedEnchant => ({ packedEnchant, weight: 1 }))
);

describe('PlexCombo', () => {
    it('represents the empty concrete combo', () => {
        const registry = RegistryFactory.build('1.21.11');
        const materialized = materializePlexCombo(EMPTY_PLEX_COMBO, registry.enchantToIndex);

        assert.strictEqual(isConcretePlexCombo(EMPTY_PLEX_COMBO), true);
        assert.strictEqual(getPlexSlotCount(EMPTY_PLEX_COMBO), 0);
        assert.deepStrictEqual(materialized, [0]);
    });

    it('materializes fixed picks with the same canonical packed combo as ComboUtils', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const fixed = kernel.getPool(30).entries.slice(0, 3).map(entry => entry.packedEnchant);
        const combo = createPlexCombo(fixed);

        assert.strictEqual(isConcretePlexCombo(combo), true);
        assert.strictEqual(getPlexSlotCount(combo), 3);
        assert.deepStrictEqual(materializePlexCombo(combo, registry.enchantToIndex), [ComboUtils.pack(fixed, registry.enchantToIndex)]);
    });

    it('keeps equivalent fixed and choice ordering canonical', () => {
        const first = createPlexCombo([packed(3), packed(1)], [[packed(20), packed(10)], [packed(40), packed(30)]]);
        const second = createPlexCombo([packed(1), packed(3)], [[packed(30), packed(40)], [packed(10), packed(20)]]);

        assert.strictEqual(samePlexCombo(first, second), true);
    });

    it('appends singleton edges as fixed picks and grouped edges as choices', () => {
        const single = appendPlexEdge(EMPTY_PLEX_COMBO, { choice: choice([packed(10)]) });
        const grouped = appendPlexEdge(single, { choice: choice([packed(20), packed(30)]) });

        assert.strictEqual(isConcretePlexCombo(single), true);
        assert.strictEqual(isConcretePlexCombo(grouped), false);
        assert.deepStrictEqual([...grouped.fixed], [packed(10)]);
        assert.deepStrictEqual(grouped.choices.map(choice => [...choice]), [[packed(20), packed(30)]]);
        assert.strictEqual(getPlexSlotCount(grouped), 2);
    });

    it('materializes cartesian products of independent choice lists', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const entries = kernel.getPool(30).entries.map(entry => entry.packedEnchant);
        const fixed = entries[0]!;
        const left = [entries[1]!, entries[2]!];
        const right = [entries[3]!, entries[4]!];
        const combo = createPlexCombo([fixed], [right, left]);
        const expected = [
            [fixed, left[0]!, right[0]!],
            [fixed, left[0]!, right[1]!],
            [fixed, left[1]!, right[0]!],
            [fixed, left[1]!, right[1]!]
        ].map(materialized => ComboUtils.pack(materialized, registry.enchantToIndex));

        assert.deepStrictEqual(materializePlexCombo(combo, registry.enchantToIndex), expected);
    });

    it('can accumulate payload choices from real PlexGraph edges', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const graph = new PlexGraph(kernel, kernel.getPool(30));
        const expansion = graph.getExpansion(graph.getRootNode(30).id);
        const groupedEdge = expansion.edges.find(edge => edge.choice.alternatives.length >= 6);
        assert.ok(groupedEdge, 'fixture should expose a grouped damage edge');

        const combo = appendPlexEdge(EMPTY_PLEX_COMBO, groupedEdge!);
        const materialized = materializePlexCombo(combo, registry.enchantToIndex);

        assert.strictEqual(combo.choices.length, 1);
        assert.strictEqual(materialized.length, groupedEdge!.choice.alternatives.length);
        assert.deepStrictEqual(
            materialized,
            getPlexChoicePackedEnchants(groupedEdge!.choice).map(alternative => ComboUtils.pack([alternative], registry.enchantToIndex))
        );
    });

    it('rejects empty weighted choices', () => {
        assert.throws(() => canonicalizeWeightedChoice([]), /empty plex weighted choice/);
    });
});
