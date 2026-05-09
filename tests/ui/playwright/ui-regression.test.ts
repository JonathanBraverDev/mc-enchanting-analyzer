import { test, expect } from '@playwright/test';
import { AnalyzerPage } from '#tests/ui/playwright/pom/analyzer-page.js';
import { TEST_DATA } from '#tests/infra/test-data.js';

const ROMAN_VALUES: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5 };

function enchantCount(comboName: string): number {
    return comboName.split(' + ').filter(Boolean).length;
}

function rankSum(comboName: string): number {
    return comboName.split(' + ').reduce((sum, enchant) => {
        const rank = enchant.trim().split(/\s+/).at(-1) ?? '';
        return sum + (ROMAN_VALUES[rank] ?? 0);
    }, 0);
}

function expectDescending(values: number[], label: string): void {
    expect(values.length, `${label} should have visible combo rows`).toBeGreaterThan(1);
    expect(values, label).toEqual([...values].sort((a, b) => b - a));
}

test.describe('UI Regression & Edge Cases', () => {
    let analyzer: AnalyzerPage;

    test.beforeEach(async ({ page }) => {
        analyzer = new AnalyzerPage(page);
        await analyzer.goto();
    });

    test('should refresh controls and results when switching book versions', async () => {
        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.selectVersion(TEST_DATA.VERSIONS.MODERN);
            await analyzer.selectCategory(TEST_DATA.ITEMS.BOOK);
        });

        await analyzer.waitForResults();
        await expect(analyzer.versionSelect).toHaveValue(TEST_DATA.VERSIONS.MODERN);
        await expect(analyzer.categorySelect).toHaveValue(TEST_DATA.ITEMS.BOOK);

        await analyzer.page.reload();
        await analyzer.page.waitForLoadState('networkidle');
        await analyzer.page.waitForTimeout(500);

        await analyzer.selectVersion(TEST_DATA.VERSIONS.LEGACY);
        await analyzer.page.waitForTimeout(200);
        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.selectCategory(TEST_DATA.ITEMS.BOOK);
        });

        await analyzer.waitForResults();
        await expect(analyzer.versionSelect).toHaveValue(TEST_DATA.VERSIONS.LEGACY);
        await expect(analyzer.categorySelect).toHaveValue(TEST_DATA.ITEMS.BOOK);
    });

    test('should prevent selecting Netherite in versions before 1.16', async () => {
        // Force a page reload to ensure a clean state for this sensitive version check
        await analyzer.page.reload();
        await analyzer.selectCategory(TEST_DATA.ITEMS.SWORD);

        // 1.21 has Netherite
        await analyzer.selectVersion(TEST_DATA.VERSIONS.MODERN);
        await expect(analyzer.materialSelect.locator(`option[value="${TEST_DATA.MATERIALS.NETHERITE}"]`)).toBeAttached({ timeout: 10000 });

        // Before 1.16 does not have Netherite
        await analyzer.selectVersion(TEST_DATA.VERSIONS.LEGACY);
        // Wait for the dropdown to update (it might be fast, but being explicit is better)
        await expect(analyzer.materialSelect.locator(`option[value="${TEST_DATA.MATERIALS.NETHERITE}"]`)).not.toBeAttached({ timeout: 10000 });
    });

    test('should prevent selecting Copper in versions before 1.21.9', async () => {
        await analyzer.selectCategory(TEST_DATA.ITEMS.SWORD);

        // 1.21.9 has Copper
        await analyzer.selectVersion(TEST_DATA.VERSIONS.POST_COPPER);
        await expect(analyzer.materialSelect.locator(`option[value="${TEST_DATA.MATERIALS.COPPER}"]`)).toBeAttached({ timeout: 10000 });

        // Before 1.21.9 (like 1.21) does not have Copper
        await analyzer.selectVersion(TEST_DATA.VERSIONS.MODERN);
        await expect(analyzer.materialSelect.locator(`option[value="${TEST_DATA.MATERIALS.COPPER}"]`)).not.toBeAttached({ timeout: 10000 });
    });

    test('should sort combinations by different metrics', async () => {
        await analyzer.selectCategory('pickaxe');
        await analyzer.waitForRefinementComplete();

        await analyzer.selectComboSort('count');
        await analyzer.waitForResults();
        const byCount = await analyzer.page.locator('#combo-list .combo-names').allTextContents();
        expectDescending(byCount.map(enchantCount), 'Most Enchantments sort');

        await analyzer.selectComboSort('rank');
        await analyzer.waitForResults();
        const byRank = await analyzer.page.locator('#combo-list .combo-names').allTextContents();
        expectDescending(byRank.map(rankSum), 'Highest Total Rank sort');
    });

    test('should update the UI when switching from no clue to an explicit clue', async () => {
        await analyzer.selectCategory('pickaxe');

        await analyzer.selectClue('');
        await analyzer.waitForRefinementComplete();
        await expect(analyzer.clueSelect).toHaveValue('');
        await expect(analyzer.comboItems.first()).toBeVisible();

        await analyzer.selectClue('Efficiency IV');
        await analyzer.waitForRefinementComplete();
        await expect(analyzer.clueSelect).toHaveValue('Efficiency IV');
        await expect(analyzer.rankSection).toContainText('Any Efficiency');
    });

    test('should update enchantability display when material changes', async () => {
        await analyzer.selectCategory('sword');

        await analyzer.selectMaterial(TEST_DATA.MATERIALS.DIAMOND);
        const diamondValue = await analyzer.enchantabilityValue.textContent();
        expect(diamondValue).toMatch(/\d+/);

        await analyzer.selectMaterial(TEST_DATA.MATERIALS.GOLD);
        await expect(analyzer.enchantabilityValue).not.toHaveText(diamondValue ?? '');
    });

    test('should render results after selecting the God Armor period', async () => {
        await analyzer.selectVersion(TEST_DATA.GOD_ARMOR.START);
        await analyzer.selectCategory(TEST_DATA.ITEMS.CHESTPLATE);
        await analyzer.selectClue('Protection IV');

        await analyzer.waitForRefinementComplete();
        await expect(analyzer.versionSelect).toHaveValue(TEST_DATA.GOD_ARMOR.START);
        await expect(analyzer.comboItems.first()).toBeVisible();
    });

    test('should render results after selecting the post-God-Armor period', async () => {
        await analyzer.selectVersion(TEST_DATA.GOD_ARMOR.END);
        await analyzer.selectCategory(TEST_DATA.ITEMS.CHESTPLATE);
        await analyzer.selectClue('Protection IV');

        await analyzer.waitForRefinementComplete();
        await expect(analyzer.versionSelect).toHaveValue(TEST_DATA.GOD_ARMOR.END);
        await expect(analyzer.comboItems.first()).toBeVisible();
    });
});
