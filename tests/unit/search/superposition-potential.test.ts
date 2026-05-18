import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RegistryFactory, RegistryKernel, SearchGraph } from '#lib/index.js';
import {
    analyzeExpansionSuperpositionPotential,
    analyzePoolSuperpositionPotential
} from '#lib/search/superposition/SuperpositionPotentialDiagnostics.js';
import { ComboUtils } from '#utils/index.js';

describe('superposition potential diagnostics', () => {
    it('groups pool alternatives that share identical future exclusion masks', () => {
        const registry = RegistryFactory.build('1.21');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const diagnostics = analyzePoolSuperpositionPotential(kernel.getPool(30));

        assert.ok(diagnostics.choiceGroupCount > 0);
        assert.ok(diagnostics.groupedEntryCount > 0);
        assert.ok(diagnostics.largestChoiceGroupSize >= 6);

        const largest = diagnostics.choiceGroups.find(group => group.alternatives.length >= 6)!;
        const names = new Set(largest.alternatives.map(packed => registry.revIdMap[ComboUtils.getEnchantId(packed)]));
        for (const name of ['Sharpness', 'Smite', 'Bane of Arthropods', 'Impaling', 'Density', 'Breach']) {
            assert.ok(names.has(name), `expected largest choice group to include ${name}`);
        }
    });

    it('reports the same root potential through SearchGraph expansions', () => {
        const registry = RegistryFactory.build('1.21');
        const kernel = new RegistryKernel({ registry, item: 'book', material: 'book' });
        const pool = kernel.getPool(30);
        const graph = new SearchGraph(kernel, pool);
        const rootExpansion = graph.getExpansion(graph.getRootNode(30).id);

        const poolDiagnostics = analyzePoolSuperpositionPotential(pool);
        const expansionDiagnostics = analyzeExpansionSuperpositionPotential(rootExpansion);

        assert.strictEqual(expansionDiagnostics.eligibleEntryCount, poolDiagnostics.eligibleEntryCount);
        assert.strictEqual(expansionDiagnostics.choiceGroupCount, poolDiagnostics.choiceGroupCount);
        assert.strictEqual(expansionDiagnostics.groupedEntryCount, poolDiagnostics.groupedEntryCount);
        assert.strictEqual(expansionDiagnostics.largestChoiceGroupSize, poolDiagnostics.largestChoiceGroupSize);
    });
});
