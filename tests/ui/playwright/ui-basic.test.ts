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
        await expect(analyzer.levelValue).toHaveText('30');
        await expect(analyzer.levelSlider).toHaveValue('30');

        const target = await analyzer.page.evaluate(() => {
            const app = (window as any).App;
            const chart = app.chartManager.chartInstance;
            const midpointY = (chart.chartArea.top + chart.chartArea.bottom) / 2;
            return {
                outsideX: Math.max(1, chart.chartArea.left - 5),
                y: midpointY,
                x: chart.scales.x.getPixelForValue(14)
            };
        });

        await analyzer.chartCanvas.click({ position: { x: target.outsideX, y: target.y } });
        await expect(analyzer.levelValue).toHaveText('30');
        await expect(analyzer.levelSlider).toHaveValue('30');

        await analyzer.chartCanvas.click({ position: { x: target.x, y: target.y } });
        await expect(analyzer.levelValue).toHaveText('15');
        await expect(analyzer.levelSlider).toHaveValue('15');
        await analyzer.waitForRefinementComplete();
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

    test('should render tiny combo probabilities without hiding readable numbers', async () => {
        await analyzer.waitForRefinementComplete();

        await analyzer.page.evaluate(() => {
            const app = (window as any).App;
            const accounting = {
                resolved: 1,
                clueIncompatible: 0,
                pending: 0,
                sieved: 0,
                overflow: 0,
                capped: 0,
                rounding: 0
            };

            app.results.updateV5({
                input: {},
                refinementLevel: 'coarse',
                clueConditioned: false,
                normalization: { domain: 'resolved-mass' },
                accounting,
                combos: [
                    { enchants: ['Readable Percent'], share: 0.0001, enchantCount: 1, rankSum: 1 },
                    { enchants: ['Full Odds'], share: 0.000012, enchantCount: 1, rankSum: 1 },
                    { enchants: ['Named Odds'], share: 1 / 14_000_000, enchantCount: 1, rankSum: 1 },
                    { enchants: ['Scientific Odds'], share: 1 / 1_056_000_000, enchantCount: 1, rankSum: 1 }
                ],
                enchants: []
            }, { resolvedRegistry: {}, romanMap: {} });
        });

        await expect(analyzer.comboItems.nth(0).locator('.combo-prob')).toHaveText('0.01%');
        await expect(analyzer.comboItems.nth(1).locator('.combo-prob')).toHaveText('1 in 83,334');
        await expect(analyzer.comboItems.nth(2).locator('.combo-prob')).toHaveText('1 in 14 million');

        const scientificOdds = analyzer.comboItems.nth(3).locator('.combo-prob');
        await expect(scientificOdds).toHaveAttribute('title', '1 in 1.06 billion (1 in 1.06 × 10^9)');
        await expect(scientificOdds.locator('.combo-prob-alt-human')).toHaveText('1 in 1.06 billion');
        await expect(scientificOdds.locator('.combo-prob-alt-scientific')).toContainText('1 in 1.06 × 10');
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
