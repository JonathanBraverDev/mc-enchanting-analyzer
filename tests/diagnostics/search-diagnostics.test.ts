import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateSearchOverlapReport } from '../../scripts/diagnose_search_overlap.js';
import { generateSearchReporting } from '../../scripts/run_search_reporting.js';

describe('Search diagnostics scripts', () => {
    it('generates a V7 reporting shape with mass-target checkpoints', async () => {
        const result = await generateSearchReporting({
            version: '1.21.11',
            item: 'mace',
            material: 'mace',
            xpLevels: [1],
            threshold: 0,
            maxIterations: 500,
            massTargets: [0.25],
            outputDir: 'unused'
        });

        assert.strictEqual(result.reports.length, 1);
        const report = result.reports[0]!;
        assert.strictEqual(report.checkpoints.length, 2);
        assert.strictEqual(report.checkpoints[0]!.targetClassifiedMass, 0.25);
        assert.ok(report.checkpoints[0]!.classifiedMass >= 0.25);
        assert.ok(report.checkpoints[0]!.lastExpandedMass > 0);
        assert.ok(report.final.iterations >= report.checkpoints[0]!.iterations);
    });

    it('generates a V7 overlap shape with graph and template stats', async () => {
        const report = await generateSearchOverlapReport({
            version: '1.21.11',
            item: 'mace',
            material: 'mace',
            xp: 1,
            threshold: 0,
            maxIterations: 500
        });

        assert.ok(report.summary.modifiedLevelCount > 0);
        assert.ok(report.summary.graphCount > 0);
        assert.ok(report.summary.graphNodeCount > 0);
        assert.ok(report.summary.graphExpansionCount > 0);
        assert.ok(report.summary.currentCandidateChecks > 0);
        assert.ok(report.groups.pools.length > 0);
        assert.ok(report.generalizedPoolFamilies.length > 0);
    });
});
