import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory } from '#core/factory.js';
import { RegistryKernel } from '#lib/search/index.js';
import { SearchGraph } from '#lib/search/SearchGraph.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { SearchExpansionBlueprintCache } from '#lib/search/SearchExpansionBlueprintCache.js';
import type { SearchGraphExpansion, SearchGraphNodeId } from '#lib/search/SearchGraph.js';
import type { SearchPool } from '#lib/search/index.js';

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

    it('uses generalized blueprints without changing exact expansion edges', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const pair = findRankVariantPoolPair(kernel);
        assert.ok(pair, 'fixture should include rank-variant book pools');

        const sharedBlueprints = new SearchExpansionBlueprintCache();
        const warmGraph = new SearchGraph(kernel, pair!.a, { blueprintCache: sharedBlueprints });
        expandFirstChild(warmGraph, 30);

        const optimized = new SearchGraph(kernel, pair!.b, { blueprintCache: sharedBlueprints });
        const baseline = new SearchGraph(kernel, pair!.b, { useExpansionBlueprints: false });
        const optimizedExpansion = expandFirstChild(optimized, 30);
        const baselineExpansion = expandFirstChild(baseline, 30);

        assertExpansionsEqual(optimized, optimizedExpansion, baseline, baselineExpansion);
        assert.ok(optimized.getDiagnostics().blueprints.hits > 0, 'second graph should reuse a family blueprint');
        assert.ok(optimized.getDiagnostics().blueprints.savedCandidateChecks > 0);
    });

    it('does not assign suffix identities to roots', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const graph = new SearchGraph(kernel, kernel.getPool(30));

        assert.strictEqual(graph.getSuffixIdentity(graph.getRootNode(30).id), undefined);
    });

    it('keeps rank-variant suffixes distinct while the variant enchant remains eligible', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const fixture = findRankVariantSuffixCase(kernel);
        assert.ok(fixture, 'fixture should include a common pick that leaves a rank variant eligible');

        const pickedA = createPickedNode(kernel, fixture!.pair.a, fixture!.nonConflictingPackedEnchant);
        const pickedB = createPickedNode(kernel, fixture!.pair.b, fixture!.nonConflictingPackedEnchant);
        const sizeA = pickedA.graph.size;
        const sizeB = pickedB.graph.size;

        assert.notStrictEqual(pickedA.graph.getSuffixIdentity(pickedA.child), pickedB.graph.getSuffixIdentity(pickedB.child));
        assert.strictEqual(pickedA.graph.size, sizeA, 'suffix identity should not materialize child edges');
        assert.strictEqual(pickedB.graph.size, sizeB, 'suffix identity should not materialize child edges');
    });

    it('shares suffix identity after a conflicting pick removes rank-variant future edges', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const fixture = findRankVariantSuffixCase(kernel);
        assert.ok(fixture, 'fixture should include a common conflicting pick that removes rank variants');

        const sharedBlueprints = new SearchExpansionBlueprintCache();
        const pickedA = createPickedNode(kernel, fixture!.pair.a, fixture!.conflictingPackedEnchant, sharedBlueprints);
        const pickedB = createPickedNode(kernel, fixture!.pair.b, fixture!.conflictingPackedEnchant, sharedBlueprints);
        const identityA = pickedA.graph.getSuffixIdentity(pickedA.child);
        const identityB = pickedB.graph.getSuffixIdentity(pickedB.child);

        assert.ok(identityA);
        assert.strictEqual(identityA, identityB);
        assert.ok(pickedB.graph.getDiagnostics().blueprints.hits > 0, 'second graph should reuse the family blueprint for suffix identity');
    });
});

function expandFirstChild(graph: SearchGraph, level: number): SearchGraphExpansion {
    const root = graph.getRootNode(level);
    const firstEdge = graph.getExpansion(root.id).edges[0];
    assert.ok(firstEdge, 'fixture should expose at least one root edge');
    return graph.getExpansion(firstEdge.childId);
}

function assertExpansionsEqual(
    optimizedGraph: SearchGraph,
    optimized: SearchGraphExpansion,
    baselineGraph: SearchGraph,
    baseline: SearchGraphExpansion
): void {
    assert.strictEqual(optimized.terminalReason, baseline.terminalReason);
    assert.strictEqual(optimized.probContinue, baseline.probContinue);
    assert.strictEqual(optimized.totalWeight, baseline.totalWeight);
    assert.strictEqual(optimized.edges.length, baseline.edges.length);

    for (let i = 0; i < optimized.edges.length; i++) {
        const left = optimized.edges[i]!;
        const right = baseline.edges[i]!;
        assert.strictEqual(left.entry.packedEnchant, right.entry.packedEnchant);
        assert.strictEqual(left.entry.enchantId, right.entry.enchantId);
        assert.strictEqual(left.entry.comboIndex, right.entry.comboIndex);
        assert.strictEqual(left.weight, right.weight);

        const leftChild = optimizedGraph.getNode(left.childId);
        const rightChild = baselineGraph.getNode(right.childId);
        assert.strictEqual(leftChild.selectedMask, rightChild.selectedMask);
        assert.strictEqual(leftChild.currentLevel, rightChild.currentLevel);
        assert.strictEqual(leftChild.combo, rightChild.combo);
        assert.strictEqual(leftChild.count, rightChild.count);
    }
}

function findRankVariantPoolPair(kernel: RegistryKernel): { a: SearchPool; b: SearchPool } | undefined {
    const byFamily = new Map<string, SearchPool[]>();
    for (let level = 1; level <= 50; level++) {
        const pool = kernel.getPool(level);
        let family = byFamily.get(pool.familySignature);
        if (!family) {
            family = [];
            byFamily.set(pool.familySignature, family);
        }
        if (!family.some(candidate => candidate.signature === pool.signature)) family.push(pool);
    }

    for (const pools of byFamily.values()) {
        if (pools.length >= 2) return { a: pools[0]!, b: pools[1]! };
    }
    return undefined;
}

interface RankVariantSuffixCase {
    pair: { a: SearchPool; b: SearchPool };
    nonConflictingPackedEnchant: number;
    conflictingPackedEnchant: number;
}

function findRankVariantSuffixCase(kernel: RegistryKernel): RankVariantSuffixCase | undefined {
    const pairs = findRankVariantPoolPairs(kernel);
    for (const pair of pairs) {
        for (let entryIndex = 0; entryIndex < pair.a.entries.length; entryIndex++) {
            const variantA = pair.a.entries[entryIndex]!;
            const variantB = pair.b.entries[entryIndex]!;
            if (variantA.enchantId !== variantB.enchantId || variantA.packedEnchant === variantB.packedEnchant) continue;

            const commonEntries = pair.a.entries.filter(entry => {
                const matching = pair.b.entries.find(candidate => candidate.packedEnchant === entry.packedEnchant);
                return matching
                    && matching.comboIndex === entry.comboIndex
                    && matching.weight === entry.weight
                    && matching.conflictBitset === entry.conflictBitset;
            });
            const nonConflicting = commonEntries.find(entry => entry.enchantId !== variantA.enchantId && (variantA.conflictBitset & entry.idBit) === 0n);
            const conflicting = commonEntries.find(entry => entry.enchantId !== variantA.enchantId && (variantA.conflictBitset & entry.idBit) !== 0n);
            if (!nonConflicting || !conflicting) continue;

            const nonConflictingA = createPickedNode(kernel, pair.a, nonConflicting.packedEnchant);
            const nonConflictingB = createPickedNode(kernel, pair.b, nonConflicting.packedEnchant);
            const conflictingA = createPickedNode(kernel, pair.a, conflicting.packedEnchant);
            const conflictingB = createPickedNode(kernel, pair.b, conflicting.packedEnchant);
            if (
                nonConflictingA.graph.getSuffixIdentity(nonConflictingA.child) !== nonConflictingB.graph.getSuffixIdentity(nonConflictingB.child)
                && conflictingA.graph.getSuffixIdentity(conflictingA.child) === conflictingB.graph.getSuffixIdentity(conflictingB.child)
            ) {
                return {
                    pair,
                    nonConflictingPackedEnchant: nonConflicting.packedEnchant,
                    conflictingPackedEnchant: conflicting.packedEnchant
                };
            }
        }
    }
    return undefined;
}

function findRankVariantPoolPairs(kernel: RegistryKernel): Array<{ a: SearchPool; b: SearchPool }> {
    const byFamily = new Map<string, SearchPool[]>();
    for (let level = 1; level <= 50; level++) {
        const pool = kernel.getPool(level);
        let family = byFamily.get(pool.familySignature);
        if (!family) {
            family = [];
            byFamily.set(pool.familySignature, family);
        }
        if (!family.some(candidate => candidate.signature === pool.signature)) family.push(pool);
    }

    const pairs: Array<{ a: SearchPool; b: SearchPool }> = [];
    for (const pools of byFamily.values()) {
        for (let i = 0; i < pools.length; i++) {
            for (let j = i + 1; j < pools.length; j++) {
                pairs.push({ a: pools[i]!, b: pools[j]! });
            }
        }
    }
    return pairs;
}

function createPickedNode(
    kernel: RegistryKernel,
    pool: SearchPool,
    packedEnchant: number,
    blueprintCache?: SearchExpansionBlueprintCache
): { graph: SearchGraph; child: SearchGraphNodeId } {
    const graph = new SearchGraph(kernel, pool, { blueprintCache });
    const root = graph.getRootNode(30);
    const edge = graph.getExpansion(root.id).edges.find(candidate => candidate.entry.packedEnchant === packedEnchant);
    assert.ok(edge, `fixture should expose packed enchant ${packedEnchant}`);
    return { graph, child: edge.childId };
}
