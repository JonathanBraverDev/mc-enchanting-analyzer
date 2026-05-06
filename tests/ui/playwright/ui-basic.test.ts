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
        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.selectCategory(TEST_DATA.ITEMS.BOW);
        });

        await expect(analyzer.categorySelect).toHaveValue(TEST_DATA.ITEMS.BOW);
        await analyzer.waitForResults();
    });

    test('should render the chart canvas', async () => {
        await expect(analyzer.chartCanvas).toBeVisible();
    });

    test('should set enchanting level when clicking the chart sweep', async () => {
        await analyzer.waitForChartIdle();

        const target = await analyzer.page.evaluate(() => {
            const app = (window as any).App;
            const chart = app.chartManager.chartInstance;
            const canvas = document.getElementById('mainChart') as HTMLCanvasElement;
            const bounds = canvas.getBoundingClientRect();
            return {
                x: bounds.left + chart.scales.x.getPixelForValue(14),
                y: bounds.top + ((chart.chartArea.top + chart.chartArea.bottom) / 2)
            };
        });

        await analyzer.page.mouse.click(target.x, target.y);
        await expect(analyzer.levelValue).toHaveText('15');
    });

    test('should display total enchantability', async () => {
        await analyzer.selectCategory(TEST_DATA.ITEMS.SWORD);
        await analyzer.selectMaterial(TEST_DATA.MATERIALS.DIAMOND);
        await expect(analyzer.enchantabilityValue).toHaveText(/\d+/);
    });

    test('should filter top combinations by selected targets', async () => {
        await analyzer.waitForRefinementComplete();

        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.addTarget('Sharpness I+');
        });

        await expect(analyzer.targetChips).toContainText(['Sharpness I+']);
        await expect(analyzer.comboList).toContainText('Target Match (Sharpness I+)');
        await expect(analyzer.comboList).not.toContainText('Best Shown Clues');

        await expect(analyzer.comboItems.first()).toBeVisible();

        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.selectComboSort('advisor');
        });
        await expect(analyzer.comboList).toContainText('Best Shown Clues');
        await expect(analyzer.comboList).toContainText('any');
        await expect(analyzer.comboList).toContainText('compatible');
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
        await expect(analyzer.comboList).toContainText('Target Match (Efficiency I+ + Fortune I+)');
        await expect(analyzer.comboItems.first()).toBeVisible();
    });

    test('should show high-roll clue signals when advisor mode has no target', async () => {
        await analyzer.selectCategory('boots');
        await analyzer.waitForRefinementComplete();

        await analyzer.selectComboSort('advisor');

        await expect(analyzer.comboList).toContainText('Best High-Roll Clues');
        await expect(analyzer.comboList).toContainText('avg ML');
        await expect(analyzer.comboList).toContainText('Best Level + High-Roll Clue');
    });

    test('should hide target options that conflict with selected targets', async () => {
        await analyzer.waitForRefinementComplete();

        await analyzer.addTarget('Sharpness I+');

        await expect(analyzer.targetChips).toContainText(['Sharpness I+']);
        await expect(analyzer.targetSelect.locator('option', { hasText: 'Smite I+' })).toHaveCount(0);
        await expect(analyzer.targetSelect.locator('option', { hasText: 'Bane of Arthropods I+' })).toHaveCount(0);
    });

    test('should explain target sets that no modified level can roll together', async () => {
        await analyzer.selectCategory('boots');
        await analyzer.waitForRefinementComplete();

        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.addTarget('Feather Falling IV+');
        });
        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.addTarget('Depth Strider III+');
        });

        await expect(analyzer.comboList).toContainText('Target Match (Depth Strider III+ + Feather Falling IV+)');
        await expect(analyzer.comboList).toContainText('Impossible at this level');
        await expect(analyzer.comboList).toContainText('no modified enchantment level can roll all selected target ranks together');
    });
});
