import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RegistryFactory, RegistryKernel } from '#lib/index.js';
import { checkFlexReducedKeyInvariant } from '#lib/search/flex/FlexReducedKeyInvariant.js';
import type { RegistryMutation } from '#types/domain.js';

const adversarialSwordCycle: readonly RegistryMutation[] = Object.freeze([
    { type: 'addConflictRule', rule: { enchants: ['Smite', 'Looting'], valid_from: '1.0' } },
    { type: 'addConflictRule', rule: { enchants: ['Looting', 'Unbreaking'], valid_from: '1.0' } },
    { type: 'addConflictRule', rule: { enchants: ['Unbreaking', 'Sharpness'], valid_from: '1.0' } }
]);

function kernel(version: string, item: string, material: string, mutations?: RegistryMutation | readonly RegistryMutation[]): RegistryKernel {
    const registry = mutations
        ? RegistryFactory.buildWithMutations(version, [...(Array.isArray(mutations) ? mutations : [mutations])])
        : RegistryFactory.build(version);
    return new RegistryKernel({ registry, item, material });
}

describe('Flex reduced structural-key invariant', () => {
    it('accepts representative vanilla registry shapes', () => {
        for (const spec of [
            { version: '1.4.6', item: 'book', material: 'book', xp: 30 },
            { version: '1.7.2', item: 'book', material: 'book', xp: 30 },
            { version: '1.14', item: 'chestplate', material: 'diamond', xp: 30 },
            { version: '1.14.3', item: 'chestplate', material: 'diamond', xp: 30 },
            { version: '1.21.11', item: 'sword', material: 'diamond', xp: 30 },
            { version: '1.21.11', item: 'trident', material: 'trident', xp: 30 },
            { version: '1.21.11', item: 'mace', material: 'mace', xp: 30 }
        ]) {
            const result = checkFlexReducedKeyInvariant({
                kernel: kernel(spec.version, spec.item, spec.material),
                xp: spec.xp
            });
            assert.strictEqual(result.ok, true, `${spec.version} ${spec.item}/${spec.material} should satisfy the Flex reduced-key invariant`);
            assert.deepStrictEqual(result.conflicts, []);
            assert.ok(result.checkedStateCount > 0);
        }
    });

    it('rejects a mutated registry whose conflict graph allows incompatible program histories per structural state', () => {
        const result = checkFlexReducedKeyInvariant({
            kernel: kernel('1.21.11', 'sword', 'diamond', adversarialSwordCycle),
            xp: 30,
            maxConflicts: 3
        });

        assert.strictEqual(result.ok, false);
        assert.ok(result.conflicts.length > 0);
        assert.notStrictEqual(result.conflicts[0]!.firstProgram, result.conflicts[0]!.nextProgram);
    });
});
