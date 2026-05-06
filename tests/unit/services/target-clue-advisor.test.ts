import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { DATA } from '#data/index.js';
import { getEnchantId } from '#core/registry.js';
import { EngineFactory } from '#engine/factory.js';
import { TargetAnalysisService } from '#services/TargetAnalysisService.js';
import { TargetClueAdvisorService } from '#services/TargetClueAdvisorService.js';
import { ComboUtils, ProbUtils, PRECISION } from '#utils/index.js';
import { makeFrontierSnapshot } from '#tests/infra/frontier-test-utils.js';
import type { ChartCellView, PackedCombo, PackedEnchant, PackedTargetRequirement, RegistryState } from '#types/index.js';

let registry: RegistryState;
let indexToEnchant: number[];
let enchantToIndex: Map<number, number>;
let targets: PackedTargetRequirement[];

let EFF_V: PackedEnchant;
let FORT_III: PackedEnchant;
let UNBR_III: PackedEnchant;

function pack(enchants: PackedEnchant[]): PackedCombo {
    return ComboUtils.pack(enchants, enchantToIndex);
}

describe('TargetClueAdvisorService', () => {
    before(() => {
        registry = EngineFactory.create(DATA, '1.21.11').registry;

        const efficiencyId = getEnchantId(registry, 'Efficiency');
        const fortuneId = getEnchantId(registry, 'Fortune');
        const unbreakingId = getEnchantId(registry, 'Unbreaking');

        EFF_V = ((efficiencyId << 8) | 5) as PackedEnchant;
        FORT_III = ((fortuneId << 8) | 3) as PackedEnchant;
        UNBR_III = ((unbreakingId << 8) | 3) as PackedEnchant;

        indexToEnchant = [0, EFF_V, FORT_III, UNBR_III];
        enchantToIndex = new Map(indexToEnchant.map((enchant, index) => [enchant, index]));
        targets = TargetAnalysisService.packTargets(registry, 'pickaxe', [
            { enchantment: 'Efficiency', rank: 4, rankMode: 'atLeast' },
            { enchantment: 'Fortune', rank: 3, rankMode: 'atLeast' }
        ]);
    });

    it('ranks clues by target chance conditioned on the shown clue', () => {
        const matching = pack([EFF_V, FORT_III]);
        const efficiencyOnly = pack([EFF_V]);
        const fortuneOnly = pack([FORT_III]);
        const unbreakingOnly = pack([UNBR_III]);

        const result = TargetClueAdvisorService.recommend({
            combos: new Map([
                [matching, PRECISION / 4n],
                [efficiencyOnly, PRECISION / 2n],
                [fortuneOnly, PRECISION / 8n],
                [unbreakingOnly, PRECISION / 8n]
            ]),
            indexToEnchant,
            targets,
            registry,
            limit: 2
        });

        assert.strictEqual(result?.recommendations[0]?.label, 'Fortune III');
        assert.strictEqual(result?.recommendations[0]?.targetAndClueMass, PRECISION / 8n);
        assert.strictEqual(result?.recommendations[0]?.clueMass, PRECISION / 4n);
        assert.strictEqual(ProbUtils.toNumber(result!.recommendations[0]!.targetChanceMass), 0.5);
        assert.strictEqual(ProbUtils.toNumber(result!.recommendations[0]!.compatibleBaselineChanceMass), 0.25);
        assert.strictEqual(result!.recommendations[0]!.liftOverCompatibleBaseline, 2);
    });

    it('includes pending frontier mass in clue recommendations', () => {
        const matching = pack([EFF_V, FORT_III]);
        const result = TargetClueAdvisorService.recommend({
            combos: new Map(),
            indexToEnchant,
            targets,
            registry,
            frontiers: makeFrontierSnapshot(matching, 2, PRECISION, PRECISION / 2n),
            limit: 2
        });

        assert.strictEqual(result?.recommendations.length, 2);
        for (const recommendation of result!.recommendations) {
            assert.strictEqual(recommendation.clueMass, PRECISION / 4n);
            assert.strictEqual(recommendation.targetAndClueMass, PRECISION / 4n);
            assert.strictEqual(recommendation.targetChanceMass, PRECISION);
        }
    });

    it('summarizes the best level and clue pairs across chart cells', () => {
        const sweep = [
            {
                xpLevel: 20,
                refinementLevel: 'ultra',
                clueConditioned: false,
                normalization: { domain: 'resolved-mass' },
                buckets: { anyByEnchantId: {}, rankByIdAndRank: {}, countBySize: {} },
                clueAdvisor: {
                    recommendations: [{
                        idAndRank: EFF_V,
                        label: 'Efficiency V',
                        targetChance: 0.2,
                        clueShare: 0.4,
                        targetAndClueShare: 0.08,
                        compatibleBaselineChance: 0.1,
                        liftOverCompatibleBaseline: 2
                    }]
                }
            },
            {
                xpLevel: 30,
                refinementLevel: 'ultra',
                clueConditioned: false,
                normalization: { domain: 'resolved-mass' },
                buckets: { anyByEnchantId: {}, rankByIdAndRank: {}, countBySize: {} },
                clueAdvisor: {
                    recommendations: [{
                        idAndRank: FORT_III,
                        label: 'Fortune III',
                        targetChance: 0.5,
                        clueShare: 0.25,
                        targetAndClueShare: 0.125,
                        compatibleBaselineChance: 0.25,
                        liftOverCompatibleBaseline: 2
                    }]
                }
            }
        ] as ChartCellView[];

        const result = TargetClueAdvisorService.summarizeSweep(sweep, 1);

        assert.strictEqual(result?.recommendations[0]?.xpLevel, 30);
        assert.strictEqual(result?.recommendations[0]?.label, 'Fortune III');
    });

    it('filters out XP levels whose modified-level range cannot satisfy all targets', () => {
        assert.strictEqual(
            TargetClueAdvisorService.supportsTargetsAtXp(registry, 'pickaxe', 'diamond', 1, targets),
            false
        );
        assert.strictEqual(
            TargetClueAdvisorService.supportsTargetsAtXp(registry, 'pickaxe', 'diamond', 30, targets),
            true
        );
    });
});
