import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory, RegistryKernel, SearchRun } from '#lib/index.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { ClueSearchPolicy } from '#engine/search/ClueSearchPolicy.js';
import { ClueValidator } from '#core/clue.js';
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

    it('carries split remainders instead of eagerly assigning them to child edges', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'mace', material: 'mace' });
        const run = new SearchRun(kernel, { distributionService: new SingleModifiedLevelDistribution() });

        run.seedXp(30);
        const snapshot = run.searchToCheckpoint({ threshold: 0n, maxIterations: 100_000 });
        const rounding = BigInt(snapshot.mass.units!.rounding);

        assert.strictEqual(snapshot.fullyResolved, true);
        assert.ok(rounding > 0n, 'integer split residue should remain accounted as rounding until it can be recovered at the same node');
        assert.strictEqual(BigInt(snapshot.mass.units!.pending), 0n);
        assert.strictEqual(totalMassUnits(snapshot), PRECISION);
        assert.strictEqual(resultMassUnits(snapshot), BigInt(snapshot.mass.units!.resolved));
        assert.strictEqual(resultMassUnits(snapshot) + rounding, PRECISION);
    });

    it('recovers carried split residue only through later arrivals to equivalent nodes', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const run = new SearchRun(kernel);

        run.seedXp(30);
        const snapshot = run.searchToCheckpoint({ threshold: 0n, maxIterations: 100_000 });

        assert.strictEqual(snapshot.fullyResolved, true);
        assert.ok(BigInt(snapshot.mass.units!.rounding) > 0n);
        assert.ok(BigInt(snapshot.mass.units!.recoveredRounding) > 0n);
        assert.strictEqual(BigInt(snapshot.mass.units!.pending), 0n);
        assert.strictEqual(totalMassUnits(snapshot), PRECISION);
    });

    it('prunes clue-incompatible branches while preserving only matching results', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const targetClueId = ClueValidator.validate(registry, 'sword', 'Sharpness III');
        const policy = ClueSearchPolicy.create(registry, [targetClueId], targetClueId);
        const run = new SearchRun(kernel, { targetClueId });

        run.seedXp(30);
        const snapshot = run.searchToCheckpoint({ threshold: 0n, maxIterations: 100_000 });

        assert.ok(snapshot.mass.resolved > 0);
        assert.ok(snapshot.mass.clueIncompatible > 0);
        assert.strictEqual(totalMassUnits(snapshot), PRECISION);
        for (const combo of snapshot.results.keys()) {
            assert.ok(policy.containsTargetClue(combo, registry.indexToEnchant));
        }
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

    it('supports an explicit exhaustive mode that ignores threshold and iteration caps', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'mace', material: 'mace' });
        const run = new SearchRun(kernel);

        run.seedXp(1);
        const snapshot = run.searchToCheckpoint({ threshold: 1, maxIterations: 1, exhaustive: true });

        assert.ok(snapshot.iterations > 1, 'exhaustive mode should bypass the caller iteration cap');
        assert.strictEqual(snapshot.fullyResolved, true);
        assert.strictEqual(BigInt(snapshot.mass.units!.pending), 0n);
        assert.strictEqual(totalMassUnits(snapshot), PRECISION);
    });
});
