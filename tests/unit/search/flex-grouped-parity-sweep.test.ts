import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DATA } from '#data/index.js';
import { RegistryFactory } from '#core/factory.js';
import { getEligibleMaterials } from '#core/registry.js';
import { getRegistryVersionBoundaries } from '#core/version-resolution.js';
import { RegistryKernel } from '#lib/search/index.js';
import { SearchRun } from '#lib/search/SearchRun.js';
import { GroupedFlexSearchRun } from '#lib/search/flex/index.js';
import { type PackedCombo } from '#types/index.js';

const MASS_TOLERANCE = 1_000n;

interface GroupedFlexParityCase {
    readonly version: string;
    readonly item: string;
    readonly material: string;
}

describe('Grouped Flex low-XP parity sweep', () => {
    // Coexistence-era parity coverage: remove this once Flex replaces concrete V7 as the default engine.
    it('matches concrete projected public rows for every vanilla item/material at XP 1', () => {
        const cases = createLowXpParityCases();
        assert.ok(cases.length > 0, 'parity matrix should include at least one case');

        for (const testCase of cases) {
            assertGroupedFlexParity(testCase);
        }
    });
});

function createLowXpParityCases(): readonly GroupedFlexParityCase[] {
    const cases: GroupedFlexParityCase[] = [];

    for (const version of getRegistryVersionBoundaries(DATA)) {
        const registry = RegistryFactory.build(version);
        for (const item of Object.keys(registry.itemPool)) {
            for (const material of getEligibleMaterials(registry, item)) {
                cases.push({ version, item, material });
            }
        }
    }

    return Object.freeze(cases);
}

function assertGroupedFlexParity(testCase: GroupedFlexParityCase): void {
    const registry = RegistryFactory.build(testCase.version);
    const kernel = new RegistryKernel({
        registry,
        item: testCase.item,
        material: testCase.material
    });
    const concreteRun = new SearchRun(kernel);
    const groupedRun = new GroupedFlexSearchRun(kernel);

    concreteRun.seedXp(1);
    groupedRun.seedXp(1);

    const request = { exhaustive: true } as const;
    const concrete = concreteRun.searchToCheckpoint(request);
    const flex = groupedRun.searchToCheckpoint(request);
    const native = groupedRun.buildEngineSnapshot(flex);

    assert.strictEqual(concrete.fullyResolved, true, label(testCase, 'concrete fully resolved'));
    assert.strictEqual(flex.fullyResolved, true, label(testCase, 'Flex fully resolved'));
    assert.strictEqual(native.snapshot.results.has(0 as PackedCombo), false, label(testCase, 'no combo row 0'));
    assert.strictEqual(
        BigInt(native.snapshot.mass.units!.resolved) + native.resolvedClueIncompatible + native.resolvedProjectionLoss,
        BigInt(flex.mass.units!.resolved),
        label(testCase, 'projected mass conservation')
    );
    assertProjectedRowsApproximatelyEqual(native.snapshot.results, concrete.results, testCase);
}

function assertProjectedRowsApproximatelyEqual(
    actual: ReadonlyMap<PackedCombo, bigint>,
    expected: ReadonlyMap<PackedCombo, bigint>,
    testCase: GroupedFlexParityCase
): void {
    assert.deepStrictEqual(
        [...actual.keys()].sort(comparePackedCombos),
        [...expected.keys()].sort(comparePackedCombos),
        label(testCase, 'combo key set')
    );

    for (const key of [...expected.keys()].sort(comparePackedCombos)) {
        const actualMass = actual.get(key) ?? 0n;
        const expectedMass = expected.get(key) ?? 0n;
        const delta = actualMass > expectedMass ? actualMass - expectedMass : expectedMass - actualMass;
        assert.ok(
            delta <= MASS_TOLERANCE,
            `${label(testCase, `combo ${String(key)}`)} expected ${String(expectedMass)}, got ${String(actualMass)}, delta ${String(delta)}`
        );
    }
}

function comparePackedCombos(left: PackedCombo, right: PackedCombo): number {
    return Number(left) - Number(right);
}

function label(testCase: GroupedFlexParityCase, detail: string): string {
    return `${testCase.version} ${testCase.item}/${testCase.material} XP 1: ${detail}`;
}
