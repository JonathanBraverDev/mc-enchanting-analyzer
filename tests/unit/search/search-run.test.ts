import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory } from '#core/factory.js';
import { RegistryKernel } from '#lib/search/index.js';
import { SearchRun } from '#lib/search/SearchRun.js';
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

function diagnosticUnits(run: SearchRun): { pending: bigint; resolved: bigint; rounding: bigint; recoveredRounding: bigint } {
    const units = run.mass.getBucketUnits();
    return {
        pending: units.pending,
        resolved: units.resolved,
        rounding: units.rounding,
        recoveredRounding: units.recoveredRounding
    };
}

class SingleModifiedLevelDistribution extends ModifiedLevelDistributionService {
    public override getModifiedLevelDist(): { [level: number]: bigint } {
        return { 30: PRECISION };
    }
}

describe('SearchRun', () => {
    it('seeds one XP cell into shared pool graphs', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const run = new SearchRun(kernel);

        run.seedXp(30);
        const snapshot = run.snapshot();

        assert.ok(snapshot.seededLevelCount > 1);
        assert.ok(snapshot.graphCount > 1);
        assert.ok(snapshot.graphCount < snapshot.seededLevelCount, 'modified levels should share pool graphs');
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

    it('tracks and recovers book removal split residue instead of assigning it to one redistributed combo', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new SearchRun(kernel);
        const combo = (3 + (2 * 256) + (1 * 256 * 256)) as any;

        (run as any).recordResolved(combo, 3, 5n, undefined);
        const residueSnapshot = run.snapshot();

        assert.strictEqual(resultMassUnits(residueSnapshot), 3n, 'only evenly divisible shares should be assigned to visible combos');
        assert.strictEqual(BigInt(residueSnapshot.mass.units!.resolved), 3n);
        assert.strictEqual(BigInt(residueSnapshot.mass.units!.rounding), 2n);
        assert.strictEqual(residueSnapshot.activeResidueMass, 2n);

        (run as any).recordResolved(combo, 3, 1n, undefined);
        const recoveredSnapshot = run.snapshot();

        assert.strictEqual(resultMassUnits(recoveredSnapshot), 6n, 'later mass for the same book combo should recover the carried split residue');
        assert.strictEqual(BigInt(recoveredSnapshot.mass.units!.resolved), 6n);
        assert.strictEqual(BigInt(recoveredSnapshot.mass.units!.rounding), 0n);
        assert.strictEqual(BigInt(recoveredSnapshot.mass.units!.recoveredRounding), 3n);
        assert.strictEqual(recoveredSnapshot.activeResidueMass, 0n);
    });

    it('keeps useful book residue diagnostics stable across chunk ordering', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const combo = (5 + (4 * 256) + (3 * 256 * 256) + (2 * 256 * 256 * 256) + (1 * 256 * 256 * 256 * 256)) as any;

        const forward = new SearchRun(kernel);
        for (const mass of [1n, 4n, 1n, 4n]) (forward as any).recordResolved(combo, 5, mass, undefined);

        const reverse = new SearchRun(kernel);
        for (const mass of [4n, 1n, 4n, 1n]) (reverse as any).recordResolved(combo, 5, mass, undefined);

        assert.deepStrictEqual(diagnosticUnits(forward), diagnosticUnits(reverse));
    });

    it('keeps useful weighted-fanout residue diagnostics stable across chunk ordering', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
        const expansion = {
            nodeId: 0,
            isRoot: false,
            probContinue: PRECISION,
            totalWeight: 6,
            eligibleCount: 3,
            terminalReason: null,
            edges: [
                { entry: { packedEnchant: 1 }, weight: 1, childId: 1 },
                { entry: { packedEnchant: 2 }, weight: 2, childId: 2 },
                { entry: { packedEnchant: 3 }, weight: 3, childId: 3 }
            ]
        };

        const forward = new SearchRun(kernel, { useSuffixMerging: false });
        for (const mass of [1n, 4n, 1n, 4n]) (forward as any).forwardMass(0, 0, expansion, mass, 0, undefined);

        const reverse = new SearchRun(kernel, { useSuffixMerging: false });
        for (const mass of [4n, 1n, 4n, 1n]) (reverse as any).forwardMass(0, 0, expansion, mass, 0, undefined);

        assert.deepStrictEqual(diagnosticUnits(forward), diagnosticUnits(reverse));
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

    it('produces identical bounded book search state with generalized blueprints enabled', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const optimized = new SearchRun(kernel, { useSuffixMerging: false });
        const baseline = new SearchRun(kernel, { useExpansionBlueprints: false, useSuffixMerging: false });

        optimized.seedXp(30);
        baseline.seedXp(30);
        const optimizedSnapshot = optimized.searchToCheckpoint({ threshold: 0n, maxIterations: 2_000 });
        const baselineSnapshot = baseline.searchToCheckpoint({ threshold: 0n, maxIterations: 2_000 });

        assert.deepStrictEqual(optimizedSnapshot.mass, baselineSnapshot.mass);
        assert.deepStrictEqual([...optimizedSnapshot.results.entries()], [...baselineSnapshot.results.entries()]);
        assert.strictEqual(optimizedSnapshot.pendingCount, baselineSnapshot.pendingCount);
        assert.strictEqual(optimizedSnapshot.largestPendingMass, baselineSnapshot.largestPendingMass);
        assert.strictEqual(optimizedSnapshot.iterations, baselineSnapshot.iterations);
        assert.strictEqual(optimizedSnapshot.activeResidueMass, baselineSnapshot.activeResidueMass);

        const blueprintHits = optimized.getGraphDiagnostics().reduce((sum, graph) => sum + graph.blueprints.hits, 0);
        assert.ok(blueprintHits > 0, 'modern book search should reuse generalized blueprints');
    });

    it('preserves exhaustive search accounting with suffix merging enabled', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'mace', material: 'mace' });
        const merged = new SearchRun(kernel, { useSuffixMerging: true });
        const baseline = new SearchRun(kernel, { useSuffixMerging: false });

        merged.seedXp(1);
        baseline.seedXp(1);
        const mergedSnapshot = merged.searchToCheckpoint({ exhaustive: true });
        const baselineSnapshot = baseline.searchToCheckpoint({ exhaustive: true });

        assert.deepStrictEqual(mergedSnapshot.mass, baselineSnapshot.mass);
        assert.deepStrictEqual([...mergedSnapshot.results.entries()], [...baselineSnapshot.results.entries()]);
        assert.strictEqual(mergedSnapshot.pendingCount, 0);
        assert.strictEqual(baselineSnapshot.pendingCount, 0);
        assert.strictEqual(totalMassUnits(mergedSnapshot), PRECISION);
        assert.strictEqual(mergedSnapshot.suffixMerging.enabled, true);
    });

    it('records suffix merge hits for modern book searches while conserving mass', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new SearchRun(kernel, { useSuffixMerging: true });

        run.seedXp(30);
        const snapshot = run.searchToCheckpoint({ threshold: 0n, maxIterations: 10_000, targetClassifiedMass: 0.5 });

        assert.ok(snapshot.suffixMerging.hits > 0, 'modern book search should share equivalent suffixes');
        assert.ok(snapshot.suffixMerging.avoidedPendingEntries > 0);
        assert.ok(snapshot.suffixMerging.mergedPendingMass > 0n);
        assert.strictEqual(totalMassUnits(snapshot), PRECISION);
        assert.ok(snapshot.activeResidueCount >= 0);
        assert.ok(snapshot.activeResidueMass >= 0n);
    });

    it('measures future-collapse potential without enabling suffix merging', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const run = new SearchRun(kernel, { useSuffixMerging: false });

        run.seedXp(30);
        run.searchToCheckpoint({ threshold: 0n, maxIterations: 10_000, targetClassifiedMass: 0.5 });
        const diagnostics = run.getFutureCollapseDiagnostics();

        assert.ok(diagnostics.eligiblePendingCount > 0);
        assert.ok(diagnostics.collapsibleGroupCount > 0);
        assert.ok(diagnostics.collapsiblePendingCount > diagnostics.collapsibleGroupCount);
        assert.ok(diagnostics.collapsibleMass > 0n);
        assert.ok(diagnostics.largestGroupSize > 1);
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

    it('rejects unlimited non-exhaustive searches without a stop condition', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'mace', material: 'mace' });
        const run = new SearchRun(kernel);

        run.seedXp(1);
        assert.throws(
            () => run.searchToCheckpoint({ threshold: 0 }),
            /no bounded stop condition/
        );
    });

    it('rejects invalid direct maxIterations values before counting them as bounded', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'mace', material: 'mace' });

        for (const maxIterations of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const run = new SearchRun(kernel);
            run.seedXp(1);
            assert.throws(
                () => run.searchToCheckpoint({ maxIterations }),
                /Invalid maxIterations: .*Must be a positive integer\./
            );
        }
    });
});
