import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DATA } from '#data/index.js';
import { RegistryFactory } from '#core/factory.js';
import { getEligibleMaterials } from '#core/registry.js';
import { getRegistryVersionBoundaries } from '#core/version-resolution.js';
import { EngineFactory } from '#engine/factory.js';
import type { EnchantStats } from '#types/index.js';

const PROBABILITY_TOLERANCE = 1e-12;
const LOW_XP_EXHAUSTIVE_CASES = createLowXpExhaustiveCases();

interface PlexParityCase {
    readonly version: string;
    readonly item: string;
    readonly material: string;
    readonly xp: number;
}

describe('Plex parity sweep', () => {
    it('matches concrete public stats for every vanilla item/material at low XP', async () => {
        assert.ok(LOW_XP_EXHAUSTIVE_CASES.length > 0, 'parity matrix should include at least one case');

        for (const testCase of LOW_XP_EXHAUSTIVE_CASES) {
            const registry = RegistryFactory.build(testCase.version);
            const engine = EngineFactory.create(registry);
            const [concrete, plex] = await Promise.all([
                engine.getStats({
                    ...testCase,
                    exhaustive: true,
                    uncappedResults: true,
                    useCache: false
                }),
                engine.getStats({
                    ...testCase,
                    exhaustive: true,
                    uncappedResults: true,
                    searchBackend: 'plex',
                    useCache: false
                })
            ]);

            assertStatsParity(testCase, concrete, plex);
        }
    });
});

function createLowXpExhaustiveCases(): readonly PlexParityCase[] {
    const cases: PlexParityCase[] = [];

    for (const version of getRegistryVersionBoundaries(DATA)) {
        const registry = RegistryFactory.build(version);
        for (const item of Object.keys(registry.itemPool)) {
            for (const material of getEligibleMaterials(registry, item)) {
                cases.push({ version, item, material, xp: 1 });
            }
        }
    }

    return Object.freeze(cases);
}

function assertStatsParity(testCase: PlexParityCase, concrete: EnchantStats, plex: EnchantStats): void {
    const label = `${testCase.version} ${testCase.item}/${testCase.material} XP ${testCase.xp}`;
    assert.strictEqual(plex.combos['0'], undefined, `${label}: Plex must not expose the empty payload as combo row 0`);
    assertApproximatelyEqual(plex.threshold, concrete.threshold, `${label}: threshold`);
    assertApproximatelyEqual(plex.accuracy, concrete.accuracy, `${label}: accuracy`);

    for (const bucket of [
        'resolved',
        'clueIncompatible',
        'pending',
        'sieved',
        'overflow',
        'capped',
        'rounding',
        'recoveredRounding',
        'recoveredSieved'
    ] as const) {
        assertApproximatelyEqual(plex.accounting[bucket], concrete.accounting[bucket], `${label}: accounting.${bucket}`);
    }

    const concreteKeys = Object.keys(concrete.combos).sort();
    const plexKeys = Object.keys(plex.combos).sort();
    if (!sameStringList(concreteKeys, plexKeys)) {
        const concreteSet = new Set(concreteKeys);
        const plexSet = new Set(plexKeys);
        const concreteOnly = concreteKeys.filter(key => !plexSet.has(key)).slice(0, 10);
        const plexOnly = plexKeys.filter(key => !concreteSet.has(key)).slice(0, 10);
        assert.fail(`${label}: combo key mismatch; concreteOnly=${concreteOnly.join(',')} plexOnly=${plexOnly.join(',')}`);
    }

    for (const key of concreteKeys) {
        assertApproximatelyEqual(plex.combos[key] ?? 0, concrete.combos[key] ?? 0, `${label}: combo ${key}`);
    }
}

function assertApproximatelyEqual(actual: number, expected: number, label: string): void {
    const delta = Math.abs(actual - expected);
    assert.ok(
        delta <= PROBABILITY_TOLERANCE,
        `${label}: expected ${expected}, got ${actual}, delta ${delta}`
    );
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}
