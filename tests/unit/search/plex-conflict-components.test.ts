import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory, RegistryKernel } from '#lib/index.js';
import { analyzePoolConflictComponents } from '#lib/search/plex/ConflictComponentDiagnostics.js';

const BOUNDARY_VERSIONS = ['1.0', '1.13', '1.14', '1.14.3', '1.21'] as const;

describe('plex conflict-component diagnostics', () => {
    it('reports disjoint active conflict components for registry boundary versions', () => {
        for (const version of BOUNDARY_VERSIONS) {
            const registry = RegistryFactory.build(version);
            const kernel = new RegistryKernel({ registry, item: 'sword', material: 'diamond' });
            const diagnostics = analyzePoolConflictComponents(kernel.getPool(30));

            assert.deepStrictEqual(
                diagnostics.duplicateMembershipEnchantIds,
                [],
                `expected no duplicate conflict-component membership for ${version}`
            );
        }
    });

    it('finds the modern six-enchant damage component in the book pool', () => {
        const registry = RegistryFactory.build('1.21');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const diagnostics = analyzePoolConflictComponents(kernel.getPool(30));

        assert.ok(diagnostics.largestComponentSize >= 6);
        const names = new Set(
            diagnostics.components
                .find(component => component.enchantIds.length >= 6)!
                .enchantIds
                .map(id => registry.revIdMap[id])
        );

        for (const name of ['Sharpness', 'Smite', 'Bane of Arthropods', 'Impaling', 'Density', 'Breach']) {
            assert.ok(names.has(name), `expected modern damage component to include ${name}`);
        }
    });
});
