import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { RegistryFactory, RegistryKernel } from '#lib/index.js';
import { SearchRun } from '#lib/search/SearchRun.js';
import {
    appendPlexPayloadEdge,
    canonicalizeWeightedChoice,
    createPlexPayload,
    EMPTY_PLEX_PAYLOAD,
    getPlexPayloadKey,
    PlexRun,
    projectPlexResults
} from '#lib/search/plex/index.js';
import { ComboUtils, PRECISION } from '#utils/index.js';

const massUnits = (snapshot: ReturnType<PlexRun['snapshot']>) => snapshot.mass.units!;
const bigintSum = (values: Iterable<bigint>) => [...values].reduce((sum, value) => sum + value, 0n);
const activeMass = (snapshot: ReturnType<PlexRun['snapshot']>) => {
    const units = massUnits(snapshot);
    return BigInt(units.resolved)
        + BigInt(units.clueIncompatible)
        + BigInt(units.pending)
        + BigInt(units.sieved)
        + BigInt(units.overflow)
        + BigInt(units.capped)
        + BigInt(units.rounding);
};

describe('PlexRun', () => {
    it('seeds modified-level mass into empty-payload plex roots', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const distributionService = new ModifiedLevelDistributionService();
        const expectedDistribution = distributionService.getModifiedLevelDist(registry, 30, kernel.enchantability);
        const run = new PlexRun(kernel, { distributionService });

        run.seedXp(30);
        const snapshot = run.snapshot();
        const pendingMass = snapshot.pendingEntries.reduce((sum, entry) => sum + entry.mass, 0n);
        const expectedPendingMass = Object.values(expectedDistribution).reduce((sum, mass) => sum + mass, 0n);

        assert.strictEqual(snapshot.pendingCount, Object.values(expectedDistribution).filter(mass => mass > 0n).length);
        assert.strictEqual(snapshot.seededLevelCount, snapshot.pendingCount);
        assert.strictEqual(snapshot.results.size, 0);
        assert.strictEqual(snapshot.iterations, 0);
        assert.strictEqual(snapshot.lastExpandedMass, 0n);
        assert.strictEqual(snapshot.fullyResolved, false);
        assert.strictEqual(pendingMass, expectedPendingMass);
        assert.strictEqual(BigInt(massUnits(snapshot).pending), expectedPendingMass);
        assert.strictEqual(BigInt(massUnits(snapshot).rounding), PRECISION - expectedPendingMass);
        assert.strictEqual(activeMass(snapshot), PRECISION);
        assert.ok(snapshot.pendingEntries.every(entry => entry.payload === EMPTY_PLEX_PAYLOAD));
        assert.ok(snapshot.pendingEntries.every(entry => entry.count === 0));
    });

    it('reuses plex graphs for repeated pool signatures while keeping roots level-specific', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const run = new PlexRun(kernel);

        run.seedXp(30);
        const snapshot = run.snapshot();
        const graphIds = new Set(snapshot.pendingEntries.map(entry => entry.graphId));
        const rootKeys = new Set(snapshot.pendingEntries.map(entry => `${entry.graphId}:${entry.nodeId}`));

        assert.strictEqual(snapshot.graphCount, graphIds.size);
        assert.ok(snapshot.graphCount < snapshot.pendingCount, 'some modified levels should share equivalent pool graphs');
        assert.strictEqual(rootKeys.size, snapshot.pendingEntries.length, 'roots remain distinct by current level');
    });

    it('expands one pending root by forwarding mass and appending payload edges', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new PlexRun(kernel);

        run.seedXp(30);
        const before = run.snapshot();
        const current = before.pendingEntries.reduce((largest, entry) => entry.mass > largest.mass ? entry : largest, before.pendingEntries[0]!);
        const graph = run.getGraph(current.graphId);
        const expansion = graph.getExpansion(current.nodeId);
        const totalWeight = BigInt(expansion.totalWeight);
        const forwarded = expansion.edges.map(edge => ({
            edge,
            mass: (current.mass * BigInt(edge.weight)) / totalWeight
        }));
        const assigned = forwarded.reduce((sum, entry) => sum + entry.mass, 0n);
        const expectedRoundingLoss = current.mass - assigned;

        assert.strictEqual(run.step(), true);
        const after = run.snapshot();
        const afterUnits = massUnits(after);
        const expandedChildren = after.pendingEntries.filter(entry => entry.graphId === current.graphId && entry.count === 1);

        assert.strictEqual(after.iterations, 1);
        assert.strictEqual(after.lastExpandedMass, current.mass);
        assert.strictEqual(BigInt(afterUnits.pending), BigInt(massUnits(before).pending) - current.mass + assigned);
        assert.strictEqual(BigInt(afterUnits.rounding), BigInt(massUnits(before).rounding) + expectedRoundingLoss);
        assert.strictEqual(expandedChildren.reduce((sum, entry) => sum + entry.mass, 0n), assigned);
        assert.strictEqual(activeMass(after), PRECISION);

        for (const { edge, mass } of forwarded) {
            if (mass === 0n) continue;
            const child = expandedChildren.find(entry => entry.nodeId === edge.childId && entry.mass === mass);
            assert.ok(child, 'forwarded child should remain pending with its split mass');
            assert.deepStrictEqual(child!.payload, appendPlexPayloadEdge(current.payload, edge));
        }
        assert.ok(expandedChildren.some(entry => entry.payload.choices.length > 0), 'book root should append at least one grouped choice payload');
    });

    it('advances by a bounded number of iterations', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new PlexRun(kernel);

        run.seedXp(30);
        const before = run.snapshot();
        const after = run.advance({ maxIterations: 3 });

        assert.strictEqual(after.iterations, before.iterations + 3);
        assert.ok(after.pendingCount > 0);
        assert.strictEqual(activeMass(after), PRECISION);
    });

    it('stops bounded advancement when the plex frontier empties', () => {
        const registry = RegistryFactory.build('1.4.6');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new PlexRun(kernel);

        run.seedXp(30);
        const snapshot = run.advance({ maxIterations: 10_000 });

        assert.strictEqual(snapshot.fullyResolved, true);
        assert.strictEqual(snapshot.pendingCount, 0);
        assert.strictEqual(run.step(), false);
        assert.strictEqual(activeMass(snapshot), PRECISION);
    });

    it('projects factorized plex results into concrete combo rows', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const entries = kernel.getPool(30).entries.map(entry => entry.packedEnchant);
        const fixed = entries[0]!;
        const left = entries[1]!;
        const right = entries[2]!;
        const payload = createPlexPayload([fixed], [
            canonicalizeWeightedChoice([
                { packedEnchant: left, weight: 2 },
                { packedEnchant: right, weight: 1 }
            ])
        ]);
        const projected = projectPlexResults(new Map([[getPlexPayloadKey(payload), { payload, mass: 10n }]]), registry.enchantToIndex);

        assert.strictEqual(projected.projectionLoss, 1n);
        assert.strictEqual(projected.projectedMass, 9n);
        assert.strictEqual(projected.mass.units?.resolved, '0');
        assert.strictEqual(projected.mass.units?.projected, '9');
        assert.strictEqual(projected.mass.units?.projectionLoss, '1');
        assert.strictEqual(projected.results.get(ComboUtils.pack([fixed, left], registry.enchantToIndex)), 6n);
        assert.strictEqual(projected.results.get(ComboUtils.pack([fixed, right], registry.enchantToIndex)), 3n);
    });

    it('classifies clue-incompatible factors during projection without resolving groups early', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const entries = kernel.getPool(30).entries.map(entry => entry.packedEnchant);
        const fixed = entries[0]!;
        const target = entries[1]!;
        const other = entries[2]!;
        const payload = createPlexPayload([fixed], [
            canonicalizeWeightedChoice([
                { packedEnchant: target, weight: 2 },
                { packedEnchant: other, weight: 1 }
            ])
        ]);
        const projected = projectPlexResults(
            new Map([[getPlexPayloadKey(payload), { payload, mass: 12n }]]),
            registry.enchantToIndex,
            undefined,
            { targetClueId: target, indexToEnchant: registry.indexToEnchant }
        );

        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedMass, 8n);
        assert.strictEqual(projected.mass.units?.projected, '8');
        assert.strictEqual(projected.mass.units?.clueIncompatible, '4');
        assert.deepStrictEqual([...projected.results.keys()], [ComboUtils.pack([fixed, target], registry.enchantToIndex)]);
    });

    it('applies book removal while projecting factorized plex results', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const entries = kernel.getPool(30).entries.map(entry => entry.packedEnchant);
        const fixed = entries[0]!;
        const left = entries[1]!;
        const right = entries[2]!;
        const payload = createPlexPayload([fixed], [
            canonicalizeWeightedChoice([
                { packedEnchant: left, weight: 2 },
                { packedEnchant: right, weight: 1 }
            ])
        ]);
        const projected = projectPlexResults(
            new Map([[getPlexPayloadKey(payload), { payload, mass: 12n }]]),
            registry.enchantToIndex,
            undefined,
            { applyBookRemoval: true }
        );

        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedMass, 12n);
        assert.strictEqual(projected.results.get(ComboUtils.pack([fixed], registry.enchantToIndex)), 6n);
        assert.strictEqual(projected.results.get(ComboUtils.pack([left], registry.enchantToIndex)), 4n);
        assert.strictEqual(projected.results.get(ComboUtils.pack([right], registry.enchantToIndex)), 2n);
    });

    it('projects run results into a concrete compatibility view', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new PlexRun(kernel);

        run.seedXp(30);
        run.advance({ maxIterations: 100 });
        const projected = run.projectResults();
        const projectedMass = bigintSum(projected.results.values());
        const resolvedMass = BigInt(massUnits(run.snapshot()).resolved);

        assert.ok(projected.results.size > 0);
        assert.strictEqual(projectedMass, projected.projectedMass);
        assert.strictEqual(projectedMass + projected.projectionLoss, resolvedMass);
        assert.strictEqual(projected.mass.units?.resolved, '0');
        assert.strictEqual(projected.mass.units?.projected, projected.projectedMass.toString());
        assert.strictEqual(projected.mass.units?.projectionLoss, projected.projectionLoss.toString());
    });

    it('compares projected plex rows with concrete SearchRun rows for a tiny exhaustive case', () => {
        const registry = RegistryFactory.build('1.4.6');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const concrete = new SearchRun(kernel);
        concrete.seedXp(30);
        const concreteSnapshot = concrete.searchToCheckpoint({ exhaustive: true });
        const plex = new PlexRun(kernel);
        plex.seedXp(30);
        const plexSnapshot = plex.advance({ maxIterations: 10_000 });
        const projected = plex.projectResults();

        assert.strictEqual(concreteSnapshot.fullyResolved, true);
        assert.strictEqual(plexSnapshot.fullyResolved, true);
        assert.deepStrictEqual(
            [...projected.results.keys()].sort((a, b) => a - b),
            [...concreteSnapshot.results.keys()].sort((a, b) => a - b)
        );
        assert.strictEqual(bigintSum(concreteSnapshot.results.values()), BigInt(concreteSnapshot.mass.units!.resolved));
        assert.strictEqual(bigintSum(projected.results.values()), projected.projectedMass);
        assert.strictEqual(projected.projectedMass + projected.projectionLoss, BigInt(plexSnapshot.mass.units!.resolved));
    });

    it('matches concrete clue-pruned result keys for a tiny exhaustive case', () => {
        const registry = RegistryFactory.build('1.4.6');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const targetClueId = kernel.getPool(30).entries[0]!.packedEnchant;
        const concrete = new SearchRun(kernel, { targetClueId });
        concrete.seedXp(30);
        const concreteSnapshot = concrete.searchToCheckpoint({ exhaustive: true });
        const plex = new PlexRun(kernel, { targetClueId });
        plex.seedXp(30);
        const plexSnapshot = plex.advance({ maxIterations: 10_000 });
        const projected = plex.projectResults();

        assert.strictEqual(concreteSnapshot.fullyResolved, true);
        assert.strictEqual(plexSnapshot.fullyResolved, true);
        assert.ok(projected.mass.clueIncompatible > 0);
        assert.deepStrictEqual(
            [...projected.results.keys()].sort((a, b) => a - b),
            [...concreteSnapshot.results.keys()].sort((a, b) => a - b)
        );
    });

    it('matches concrete multi-book result keys after book-removal projection', () => {
        const registry = RegistryFactory.build('1.7.2');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const concrete = new SearchRun(kernel);
        concrete.seedXp(30);
        const concreteSnapshot = concrete.searchToCheckpoint({ exhaustive: true });
        const plex = new PlexRun(kernel);
        plex.seedXp(30);
        const plexSnapshot = plex.advance({ maxIterations: 2_000_000 });
        const projected = plex.projectResults();

        assert.strictEqual(concreteSnapshot.fullyResolved, true);
        assert.strictEqual(plexSnapshot.fullyResolved, true);
        assert.strictEqual(projected.results.size, concreteSnapshot.results.size);
        assert.deepStrictEqual(
            [...projected.results.keys()].sort((a, b) => a - b),
            [...concreteSnapshot.results.keys()].sort((a, b) => a - b)
        );
        assert.strictEqual(bigintSum(projected.results.values()), projected.projectedMass);
        assert.strictEqual(projected.projectedMass + projected.projectionLoss, BigInt(plexSnapshot.mass.units!.resolved));
    });

    it('records resolved payload mass by canonical payload key', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new PlexRun(kernel);

        run.seedXp(30);
        for (let guard = 0; guard < 500 && run.results.size === 0; guard++) {
            assert.strictEqual(run.step(), true);
        }

        const snapshot = run.snapshot();
        const resolvedMass = [...snapshot.results.values()].reduce((sum, result) => sum + result.mass, 0n);

        assert.ok(snapshot.results.size > 0, 'single-book search should resolve after stepping into child nodes');
        assert.strictEqual(resolvedMass, BigInt(massUnits(snapshot).resolved));
        assert.strictEqual(activeMass(snapshot), PRECISION);
        for (const [key, result] of snapshot.results) {
            assert.strictEqual(key, getPlexPayloadKey(result.payload));
            assert.ok(result.payload.combo.fixed.length + result.payload.combo.choices.length > 0);
        }
    });

    it('exposes seeded plex graphs for diagnostics', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new PlexRun(kernel);

        run.seedXp(30);
        const firstPending = run.snapshot().pendingEntries[0]!;
        const graph = run.getGraph(firstPending.graphId);
        const expansion = graph.getExpansion(firstPending.nodeId);

        assert.strictEqual(expansion.isRoot, true);
        assert.ok(expansion.edges.some(edge => edge.choice.alternatives.length > 1));
    });

    it('rejects advancing before seeding', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const run = new PlexRun(kernel);

        assert.throws(() => run.advance({ maxIterations: 1 }), /must be seeded before advancing/);
    });

    it('rejects invalid advance iteration caps', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const run = new PlexRun(kernel);

        run.seedXp(30);
        assert.throws(() => run.advance({ maxIterations: 0 }), /Invalid maxIterations/);
        assert.throws(() => run.advance({ maxIterations: 1.5 }), /Invalid maxIterations/);
    });

    it('rejects stepping before seeding', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const run = new PlexRun(kernel);

        assert.throws(() => run.step(), /must be seeded before stepping/);
    });

    it('rejects seeding twice', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const run = new PlexRun(kernel);

        run.seedXp(30);
        assert.throws(() => run.seedXp(30), /can only be seeded once/);
    });
});
