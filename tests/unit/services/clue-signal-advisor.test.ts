import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_DATA } from '#tests/infra/test-data.js';
import { RegistryFactory } from '#core/factory.js';
import { ClueSignalAdvisorService } from '#services/ClueSignalAdvisorService.js';

describe('ClueSignalAdvisorService', () => {
    const registry = RegistryFactory.build(TEST_DATA.VERSIONS.MODERN);

    it('ranks clues by how much they raise the expected modified level', () => {
        const advisor = ClueSignalAdvisorService.recommend(registry, 'boots', 'diamond', 30, 10);

        assert.ok(advisor);
        const depthStrider = advisor.recommendations.find(recommendation =>
            recommendation.label === 'Depth Strider III'
        );

        assert.ok(depthStrider);
        assert.ok(depthStrider.averageModifiedLevel > depthStrider.baselineModifiedLevel);
        assert.ok(depthStrider.modifiedLevelLift > 0);
        assert.ok(depthStrider.clueShare > 0);
    });

    it('summarizes the best level and clue pairs without target requirements', () => {
        const advisor = ClueSignalAdvisorService.summarizeLevels(registry, 'boots', 'diamond', 30, 5);

        assert.ok(advisor);
        assert.equal(advisor.recommendations.length, 5);
        assert.ok(advisor.recommendations.every(recommendation => recommendation.xpLevel >= 1));
        assert.ok(advisor.recommendations.every(recommendation => recommendation.modifiedLevelLift > 0));
    });
});
