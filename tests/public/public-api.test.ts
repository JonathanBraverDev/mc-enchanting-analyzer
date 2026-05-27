import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantingAnalyzer } from '#lib/index.js';
import type {
    ConflictRule,
    EnchantableItemRule,
    Enchantment,
    EnchantmentGroupRule,
    MaterialRule,
    RegistryMutation
} from '#lib/index.js';

describe('Public package API', () => {
    it('returns human-readable insights from the analyzer facade', async () => {
        const analyzer = EnchantingAnalyzer.forVersion('1.21');

        const insights = await analyzer.insights({
            item: 'pickaxe',
            material: 'diamond',
            xp: 30,
            search: { threshold: 0.01 },
            summaryLimit: 5
        });

        assert.ok(Object.keys(insights.any).includes('Efficiency'));
        assert.ok(
            Object.keys(insights.combos).some(combo => combo.includes('Efficiency')),
            'expected display combo labels instead of packed hex-only keys'
        );
        assert.ok(
            Object.keys(insights.combos).every(combo => !/^[0-9a-f]+$/i.test(combo)),
            'human-readable combos should not expose raw packed hex keys'
        );
    });

    it('humanizes already-computed raw stats without exposing registry internals', async () => {
        const analyzer = EnchantingAnalyzer.forVersion('1.21');
        const stats = await analyzer.stats({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            search: { threshold: 0.01 },
            summaryLimit: 5
        });

        const insights = analyzer.humanize(stats, 'count');

        assert.deepStrictEqual(insights.accounting, stats.accounting);
        assert.ok(Object.keys(insights.any).includes('Sharpness'));
    });

    it('supports named presets and explicit advanced search controls', async () => {
        const analyzer = EnchantingAnalyzer.forVersion('1.21');

        const presetStats = await analyzer.stats({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            search: 'coarse',
            summaryLimit: 0
        });
        const customStats = await analyzer.stats({
            item: 'sword',
            material: 'diamond',
            xp: 30,
            search: {
                preset: 'deep',
                maxIterations: 10,
                drainEqualMassBand: true,
                probabilityFloor: 0
            },
            summaryLimit: 0
        });

        assert.ok(presetStats.threshold > 0);
        assert.ok(customStats.accounting.pending > 0);
    });

    it('supports exhaustive mode through the facade for small searches', async () => {
        const analyzer = EnchantingAnalyzer.forVersion('1.21');

        const stats = await analyzer.stats({
            item: 'sword',
            material: 'diamond',
            xp: 1,
            search: 'exhaustive',
            summaryLimit: 0
        });

        assert.ok(stats.accuracy > 0.99);
    });

    it('exports the rule types needed to build mutation-derived analyzers', async () => {
        const enchantmentPatch: Partial<Enchantment> = {
            weight: 12
        };
        const conflictRule: ConflictRule = {
            enchants: ['Efficiency', 'Silk Touch'],
            valid_from: '1.21'
        };
        const groupRule: EnchantmentGroupRule = {
            group: 'test_tools',
            enchantments: ['Efficiency'],
            valid_from: '1.21'
        };
        const materialRule: MaterialRule = {
            material: 'test_material',
            valid_from: '1.21'
        };
        const itemRule: EnchantableItemRule = {
            item: 'test_pickaxe',
            valid_from: '1.21',
            groups: ['test_tools'],
            materials: ['test_material'],
            enchantability: 'tool'
        };
        const mutations: RegistryMutation[] = [
            { type: 'patchEnchantment', enchantment: 'Efficiency', patch: enchantmentPatch },
            { type: 'addConflictRule', rule: conflictRule },
            { type: 'removeConflictRule', selector: conflictRule },
            { type: 'addEnchantmentGroupRule', rule: groupRule },
            { type: 'removeEnchantmentGroupRule', selector: groupRule },
            { type: 'addMaterialRule', rule: materialRule },
            { type: 'removeMaterialRule', selector: materialRule },
            { type: 'addEnchantableItemRule', rule: itemRule },
            { type: 'removeEnchantableItemRule', selector: itemRule }
        ];

        const analyzer = EnchantingAnalyzer.withMutations('1.21', mutations);

        assert.strictEqual(analyzer.registry.source, 'mutated');
    });
});
