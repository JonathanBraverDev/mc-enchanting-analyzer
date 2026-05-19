import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory, RegistryKernel, SearchGraph } from '#lib/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { PlexGraph, type PlexEdge } from '#lib/search/plex/PlexGraph.js';
import { ComboUtils, PRECISION, ProbUtils } from '#utils/index.js';
import type { RegistryState } from '#types/index.js';

const edgePackedEnchants = (edge: PlexEdge) => edge.choice.alternatives.map(alternative => alternative.packedEnchant);
const edgeWeights = (edge: PlexEdge) => edge.choice.alternatives.map(alternative => alternative.weight);
const tridentConflictNames = ['Channeling', 'Loyalty', 'Riptide'];

function edgeEnchantNames(registry: RegistryState, edge: PlexEdge): string[] {
    return edgePackedEnchants(edge).map(packed => registry.revIdMap[ComboUtils.getEnchantId(packed)]!);
}

function tridentConflictNamesInEdges(registry: RegistryState, edges: readonly PlexEdge[]): string[] {
    return edges
        .flatMap(edge => edgeEnchantNames(registry, edge))
        .filter(name => tridentConflictNames.includes(name))
        .sort();
}

describe('PlexGraph', () => {
    it('keys structural nodes by exclusion mask, current level, and count', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const graph = new PlexGraph(kernel, kernel.getPool(30));

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
        const graph = new PlexGraph(kernel, kernel.getPool(30));

        const low = graph.getRootNode(29);
        const high = graph.getRootNode(30);
        const repeatedHigh = graph.getRootNode(30);

        assert.strictEqual(high.id, repeatedHigh.id);
        assert.notStrictEqual(low.id, high.id);
        assert.strictEqual(high.exclusionMask, 0n);
        assert.strictEqual(high.count, 0);
    });

    it('expands root choice groups with concrete-equivalent total weight', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const pool = kernel.getPool(30);
        const concrete = new SearchGraph(kernel, pool);
        const plex = new PlexGraph(kernel, pool);

        const concreteRoot = concrete.getExpansion(concrete.getRootNode(30).id);
        const aggregateRoot = plex.getExpansion(plex.getRootNode(30).id);

        assert.strictEqual(aggregateRoot.isRoot, true);
        assert.strictEqual(aggregateRoot.probContinue, PRECISION);
        assert.strictEqual(aggregateRoot.eligibleEntryCount, concreteRoot.edges.length);
        assert.strictEqual(aggregateRoot.totalWeight, concreteRoot.totalWeight);
        assert.ok(aggregateRoot.edges.length <= concreteRoot.edges.length);
        assert.ok(aggregateRoot.edges.every(edge => edge.choice.alternatives.length > 0));
        assert.ok(aggregateRoot.edges.every(edge => edge.choice.totalWeight === edgeWeights(edge).reduce((sum, weight) => sum + weight, 0)));
        assert.ok(aggregateRoot.edges.every(edge => edge.weight === edge.choice.totalWeight));
        assert.strictEqual(plex.getExpansion(plex.getRootNode(30).id), aggregateRoot, 'expansion should be cached');
    });

    it('collapses modern damage alternatives into one root edge by shared exclusion behavior', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const graph = new PlexGraph(kernel, kernel.getPool(30));
        const expansion = graph.getExpansion(graph.getRootNode(30).id);
        const damageEdge = expansion.edges.find(edge => edge.choice.alternatives.length >= 6);

        assert.ok(damageEdge, 'fixture should expose a collapsed damage choice edge');
        const names = new Set(edgePackedEnchants(damageEdge).map(packed => registry.revIdMap[ComboUtils.getEnchantId(packed)]));
        for (const name of ['Sharpness', 'Smite', 'Bane of Arthropods', 'Impaling', 'Density', 'Breach']) {
            assert.ok(names.has(name), `expected damage edge to include ${name}`);
        }
        assert.deepStrictEqual(edgeWeights(damageEdge), [10, 5, 5, 2, 5, 2]);

        const child = graph.getNode(damageEdge.childId);
        assert.strictEqual(child.exclusionMask, damageEdge.childExclusionMask);
        assert.strictEqual(child.currentLevel, 30);
        assert.strictEqual(child.count, 1);
    });

    it('does not squash the non-clique trident conflict component into one choice', () => {
        for (const { item, material } of [
            { item: 'trident', material: 'trident' },
            { item: 'book', material: 'book' }
        ]) {
            const registry = RegistryFactory.build('1.21.11');
            const kernel = new RegistryKernel({ registry, item, material });
            const graph = new PlexGraph(kernel, kernel.getPool(30));
            const expansion = graph.getExpansion(graph.getRootNode(30).id);
            const tridentEdges = expansion.edges.filter(edge =>
                edgeEnchantNames(registry, edge).some(name => tridentConflictNames.includes(name))
            );

            const rootChoices = tridentEdges
                .map(edge => edgeEnchantNames(registry, edge))
                .sort((left, right) => left[0]!.localeCompare(right[0]!));

            assert.deepStrictEqual(
                rootChoices,
                [['Channeling'], ['Loyalty'], ['Riptide']],
                `${item} should keep the trident V-shaped conflict component as singleton choices`
            );
            assert.strictEqual(
                new Set(tridentEdges.map(edge => edge.childExclusionMask)).size,
                3,
                `${item} trident choices should lead to three distinct future exclusion states`
            );

            const edgeByName = new Map(tridentEdges.map(edge => [edgeEnchantNames(registry, edge)[0]!, edge]));
            const eligibleAfter = (name: string): string[] => {
                const edge = edgeByName.get(name);
                assert.ok(edge, `${item} should expose a root edge for ${name}`);
                return tridentConflictNamesInEdges(registry, graph.getExpansion(edge.childId).edges);
            };

            assert.deepStrictEqual(eligibleAfter('Loyalty'), ['Channeling'], `${item}: Channeling remains eligible after Loyalty`);
            assert.deepStrictEqual(eligibleAfter('Channeling'), ['Loyalty'], `${item}: Loyalty remains eligible after Channeling`);
            assert.deepStrictEqual(eligibleAfter('Riptide'), [], `${item}: Riptide blocks both Loyalty and Channeling`);
        }
    });

    it('keeps plex edge alternatives item-local instead of using whole conflict groups', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const graph = new PlexGraph(kernel, kernel.getPool(30));
        const expansion = graph.getExpansion(graph.getRootNode(30).id);
        const damageEdge = expansion.edges.find(edge => edge.choice.alternatives.length === 3);

        assert.ok(damageEdge, 'sword fixture should expose only the sword-eligible damage choices');
        const names = edgePackedEnchants(damageEdge!).map(packed => registry.revIdMap[ComboUtils.getEnchantId(packed)]);
        assert.deepStrictEqual(names, ['Sharpness', 'Smite', 'Bane of Arthropods']);
        assert.deepStrictEqual(edgeWeights(damageEdge!), [10, 5, 5]);
        assert.strictEqual(damageEdge!.weight, 20);
    });

    it('expands non-root nodes by parent exclusion mask and halves continuation level', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const pool = kernel.getPool(30);
        const concrete = new SearchGraph(kernel, pool);
        const plex = new PlexGraph(kernel, pool);

        const aggregateRoot = plex.getExpansion(plex.getRootNode(30).id);
        const singletonEdge = aggregateRoot.edges.find(edge => edge.choice.alternatives.length === 1)!;
        const aggregateExpansion = plex.getExpansion(singletonEdge.childId);

        const concreteRoot = concrete.getExpansion(concrete.getRootNode(30).id);
        const matchingConcreteEdge = concreteRoot.edges.find(edge => edge.entry.packedEnchant === edgePackedEnchants(singletonEdge)[0]);
        assert.ok(matchingConcreteEdge, 'fixture should expose the same concrete root alternative');
        const concreteExpansion = concrete.getExpansion(matchingConcreteEdge!.childId);

        assert.strictEqual(aggregateExpansion.probContinue, ProbUtils.PROB_CONTINUE_TABLE[30] ?? PRECISION);
        assert.strictEqual(aggregateExpansion.eligibleEntryCount, concreteExpansion.edges.length);
        assert.strictEqual(aggregateExpansion.totalWeight, concreteExpansion.totalWeight);
        assert.ok(aggregateExpansion.edges.length <= concreteExpansion.edges.length);
        assert.ok(aggregateExpansion.edges.every(edge => plex.getNode(edge.childId).currentLevel === 15));
    });

    it('marks max-enchant and single-book nodes terminal', () => {
        const swordRegistry = RegistryFactory.build('1.21.11');
        const swordKernel = new RegistryKernel({ registry: swordRegistry, item: 'sword', material: 'diamond' });
        const swordGraph = new PlexGraph(swordKernel, swordKernel.getPool(30));
        const maxNode = swordGraph.getOrCreateNode(0n, 1, ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM);
        const maxExpansion = swordGraph.getExpansion(maxNode.id);

        assert.strictEqual(maxExpansion.terminalReason, 'max-enchants');
        assert.strictEqual(maxExpansion.edges.length, 0);

        const bookRegistry = RegistryFactory.build('1.4.6');
        const bookKernel = new RegistryKernel({ registry: bookRegistry, item: 'book', material: 'book' });
        const bookGraph = new PlexGraph(bookKernel, bookKernel.getPool(30));
        const bookNode = bookGraph.getOrCreateNode(1n, 30, 1);
        const bookExpansion = bookGraph.getExpansion(bookNode.id);

        assert.strictEqual(bookExpansion.terminalReason, 'single-book');
        assert.strictEqual(bookExpansion.probContinue, 0n);
        assert.strictEqual(bookExpansion.edges.length, 0);
    });
});
