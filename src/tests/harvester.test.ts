import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ResidualMassHarvester } from '../engine/ResidualMassHarvester.js';
import { MassAccountant } from '../engine/MassAccountant.js';
import { SearchHeap } from '../utils/collections/SearchHeap.js';
import { PRECISION } from '../utils/math/ProbUtils.js';
import { ExpansionBlueprint, RegistryState } from '../types/index.js';

describe('ResidualMassHarvester (Engine Core Refactor)', () => {

    it('should register expansions and report cache size', () => {
        const harvester = new ResidualMassHarvester();
        assert.strictEqual(harvester.getCacheSize(), 0);

        const blueprint: ExpansionBlueprint = {
            probContinue: PRECISION / 2n,
            totalWeight: 10,
            eligibleCount: 1,
            eligibleEnchants: new Int32Array([1]),
            eligibleWeights: new Int32Array([10]),
            nextLevel: 30,
            currentCount: 1,
            currentCombo: 0,
            currentEnchants: [],
            residue: 0n
        };

        harvester.registerExpansion(123n, blueprint);
        assert.strictEqual(harvester.getCacheSize(), 1);
        assert.strictEqual(harvester.has(123n), true);
        assert.strictEqual(harvester.get(123n), blueprint);
    });

    it('should clone with its cache intact', () => {
        const harvester = new ResidualMassHarvester();
        const blueprint = { currentCount: 1 } as any;
        harvester.registerExpansion(100n, blueprint);

        const clone = harvester.clone();
        assert.strictEqual(clone.getCacheSize(), 1);
        assert.strictEqual(clone.has(100n), true);
        
        // Ensure isolation
        clone.registerExpansion(200n, blueprint);
        assert.strictEqual(clone.getCacheSize(), 2);
        assert.strictEqual(harvester.getCacheSize(), 1);
    });

    // forwardMass test is deferred to integration tests due to heavy dependency on RegistryState
    // and SearchService.settleMass which requires a fully populated registry.
});
