import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory, RegistryKernel, SearchRun } from '#lib/index.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { PRECISION, ProbUtils } from '#utils/index.js';

function totalMassUnits(snapshot: ReturnType<SearchRun['snapshot']>): bigint {
    const units = snapshot.mass.units!;
    return BigInt(units.resolved)
        + BigInt(units.clueIncompatible)
        + BigInt(units.pending)
        + BigInt(units.sieved)
        + BigInt(units.overflow)
        + BigInt(units.capped)
        + BigInt(units.rounding);
}

function resultMassUnits(snapshot: ReturnType<SearchRun['snapshot']>): bigint {
    let total = 0n;
    for (const mass of snapshot.results.values()) total += mass;
    return total;
}

class SingleModifiedLevelDistribution extends ModifiedLevelDistributionService {
    public override getModifiedLevelDist(): { [level: number]: bigint } {
        return { 30: PRECISION };
    }
}

describe('V7 SearchRun', () => {
    it('seeds one XP cell into shared pool programs', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const run = new SearchRun(kernel);

        run.seedXp(30);
        const snapshot = run.snapshot();

        assert.ok(snapshot.seededLevelCount > 1);
        assert.ok(snapshot.programCount > 1);
        assert.ok(snapshot.programCount < snapshot.seededLevelCount, 'modified levels should share pool programs');
        assert.strictEqual(totalMassUnits(snapshot), PRECISION);
        assert.strictEqual(BigInt(snapshot.mass.units!.pending), PRECISION);
    });

    it('moves weighted mass through the lazy shared graph while conserving mass', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const run = new SearchRun(kernel);

        run.seedXp(30);
        const snapshot = run.searchToCheckpoint({ threshold: 0.01, maxIterations: 500 });

        assert.ok(snapshot.iterations > 0);
        assert.ok(snapshot.results.size > 0);
        assert.ok(snapshot.mass.resolved > 0);
        assert.ok(snapshot.mass.pending > 0);
        assert.strictEqual(totalMassUnits(snapshot), PRECISION);
    });

    it('harvests split remainders locally instead of leaking them into rounding', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'mace', material: 'mace' });
        const run = new SearchRun(kernel, { distributionService: new SingleModifiedLevelDistribution() });

        run.seedXp(30);
        const snapshot = run.searchToCheckpoint({ threshold: 0n, maxIterations: 100_000 });

        assert.strictEqual(snapshot.fullyResolved, true);
        assert.strictEqual(BigInt(snapshot.mass.units!.rounding), 0n);
        assert.strictEqual(BigInt(snapshot.mass.units!.pending), 0n);
        assert.strictEqual(totalMassUnits(snapshot), PRECISION);
        assert.strictEqual(resultMassUnits(snapshot), BigInt(snapshot.mass.units!.resolved));
    });

    it('can stop once a requested resolved-mass target is reached', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const run = new SearchRun(kernel);

        run.seedXp(30);
        const target = ProbUtils.toBigInt(0.8);
        const snapshot = run.searchToCheckpoint({ threshold: 0n, targetResolvedMass: target, maxIterations: 100_000 });

        assert.ok(BigInt(snapshot.mass.units!.resolved) >= target);
        assert.ok(snapshot.mass.pending > 0, 'target stop should not require full resolution');
        assert.strictEqual(totalMassUnits(snapshot), PRECISION);
    });

    it('can fully resolve a tiny high-threshold request without pending mass', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'mace', material: 'mace' });
        const run = new SearchRun(kernel);

        run.seedXp(1);
        const snapshot = run.searchToCheckpoint({ threshold: ProbUtils.toBigInt(0), maxIterations: 100_000 });

        assert.strictEqual(snapshot.fullyResolved, true);
        assert.strictEqual(BigInt(snapshot.mass.units!.pending), 0n);
        assert.ok(snapshot.mass.resolved > 0);
        assert.strictEqual(totalMassUnits(snapshot), PRECISION);
    });
});
