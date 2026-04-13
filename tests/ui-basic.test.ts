import { test, expect } from '@playwright/test';
import { UI_TEXTS } from '../src/lib/core/config.js';
import { AnalyzerPage } from './pom/analyzer-page.js';
import { TEST_DATA } from './test-data.js';

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
});
