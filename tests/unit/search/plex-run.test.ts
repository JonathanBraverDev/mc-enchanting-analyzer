import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { RegistryFactory, RegistryKernel } from '#lib/index.js';
import { EMPTY_PLEX_PAYLOAD, PlexRun } from '#lib/search/plex/index.js';
import { PRECISION } from '#utils/index.js';

const massUnits = (snapshot: ReturnType<PlexRun['snapshot']>) => snapshot.mass.units!;

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
        assert.strictEqual(snapshot.fullyResolved, false);
        assert.strictEqual(pendingMass, expectedPendingMass);
        assert.strictEqual(BigInt(massUnits(snapshot).pending), expectedPendingMass);
        assert.strictEqual(BigInt(massUnits(snapshot).rounding), PRECISION - expectedPendingMass);
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

    it('rejects seeding twice', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const run = new PlexRun(kernel);

        run.seedXp(30);
        assert.throws(() => run.seedXp(30), /can only be seeded once/);
    });
});
