import { test, expect } from '@playwright/test';
import { UI_TEXTS } from '#core/config.js';
import { AnalyzerPage } from '#tests/ui/playwright/pom/analyzer-page.js';
import { TEST_DATA } from '#tests/infra/test-data.js';

test.describe('Basic UI Functionality', () => {
    let analyzer: AnalyzerPage;

    test.beforeEach(async ({ page }) => {
        analyzer = new AnalyzerPage(page);
        await analyzer.goto();
    });

    test('should load the page and show initial calculations', async () => {
        // App title check
        await expect(analyzer.page).toHaveTitle(UI_TEXTS.PAGE_TITLE);

        // Wait for initially triggered refinement to complete
        await analyzer.waitForRefinementComplete();

        // Check that some results are visible
        await analyzer.waitForResults();
        await expect(analyzer.comboItems.first()).toBeVisible();
    });

    test('should update calculations when item category changes', async () => {
        // Switch to Bow
        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.selectCategory(TEST_DATA.ITEMS.BOW);
        });

        // Wait for Bow refinement
        await analyzer.waitForRefinementComplete();

        // BOW should have "Power" or "Infinity" usually
        const results = await analyzer.comboList.textContent();
        expect(results).toMatch(/Power|Infinity|Unbreaking/);
    });

    test('should render the chart canvas', async () => {
        await expect(analyzer.chartCanvas).toBeVisible();
    });

    test('should display total enchantability', async () => {
        // Default is Diamond Sword (Enchantability 10)
        await analyzer.selectCategory(TEST_DATA.ITEMS.SWORD);
        await analyzer.selectMaterial(TEST_DATA.MATERIALS.DIAMOND);
        await expect(analyzer.enchantabilityValue).toHaveText('10');
    });

    test('should filter top combinations by selected targets', async () => {
        await analyzer.waitForRefinementComplete();

        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.addTarget('Sharpness I+');
        });

        await expect(analyzer.targetChips).toContainText(['Sharpness I+']);
        await expect(analyzer.comboList).toContainText('Target Match (Sharpness I+)');
        await expect(analyzer.comboList).not.toContainText('Best Shown Clues');

        const comboNames = analyzer.page.locator('#combo-list .combo-names');
        await expect(comboNames.first()).toContainText('Sharpness');

        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.selectComboSort('advisor');
        });
        await expect(analyzer.comboList).toContainText('Best Shown Clues');
        await expect(analyzer.comboList).toContainText('compatible baseline');
        await analyzer.waitForChartIdle(60000);
        await expect(analyzer.comboList).toContainText('Best Level + Clue');
    });

    test('should refresh advisor recommendations for multiple targets', async () => {
        await analyzer.selectCategory(TEST_DATA.ITEMS.PICKAXE);
        await analyzer.waitForRefinementComplete();

        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.selectComboSort('advisor');
        });

        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.addTarget('Efficiency I+');
        });
        await expect(analyzer.comboList).toContainText('Target Match (Efficiency I+)');

        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.addTarget('Fortune I+');
        });
        await analyzer.waitForChartIdle(60000);
        await expect(analyzer.comboList).toContainText('Target Match (Efficiency I+ + Fortune I+)');
        await expect(analyzer.comboList).toContainText('Fortune');
    });

    test('should hide target options that conflict with selected targets', async () => {
        await analyzer.waitForRefinementComplete();

        await analyzer.addTarget('Sharpness I+');

        await expect(analyzer.targetChips).toContainText(['Sharpness I+']);
        await expect(analyzer.targetSelect.locator('option', { hasText: 'Smite I+' })).toHaveCount(0);
        await expect(analyzer.targetSelect.locator('option', { hasText: 'Bane of Arthropods I+' })).toHaveCount(0);
    });
});
