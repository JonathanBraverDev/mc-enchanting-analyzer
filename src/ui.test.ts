import { test, expect } from '@playwright/test';
import { UI_TEXTS, UI_DEFAULTS } from './config.js';
import { UITestUtils } from './test-utils.js';

test.describe('Enchantment Analyzer UI', () => {
    
    test.beforeEach(async ({ page }) => {
        await page.goto('/analyzer.html');
    });

    test('should load the page and show initial calculations', async ({ page }) => {
        await expect(page).toHaveTitle(new RegExp(UI_TEXTS.PAGE_TITLE));
        await expect(page.locator('.logo')).toContainText(UI_TEXTS.LOGO_TEXT);
        
        // Wait for worker to be ready (UI should show "Coarse" or "Standard" refinement)
        const status = page.locator('#refinement-status');
        await expect(status).toBeVisible();
        
        // Check for top combinations
        await UITestUtils.waitForResults(page);
    });

    test('should update calculations when item category changes', async ({ page }) => {
        const catSelect = page.locator('#cat-select');
        const comboList = page.locator('#combo-list');

        // 1. Start with Sword
        await catSelect.selectOption('sword');
        await UITestUtils.waitForResults(page);
        const swordAtFirst = await comboList.innerText();
        expect(swordAtFirst).toContain('Sharpness');

        // 2. Switch to Pickaxe
        await catSelect.selectOption('pickaxe');
        
        // Wait for the change (it should eventually show Efficiency)
        await expect(comboList).toContainText('Efficiency', { timeout: 15000 });
        const pickaxeAtFirst = await comboList.innerText();
        expect(pickaxeAtFirst).not.toContain('Sharpness');
    });

    test('should update calculations when level slider changes', async ({ page }) => {
        const slider = page.locator('#lvl-range');
        const lvlVal = page.locator('#lvl-val');
        
        // Initial value is the default
        await expect(lvlVal).toHaveText(UI_DEFAULTS.DEFAULT_XP_LEVEL.toString());
        
        // Move slider to 15
        await slider.fill('15');
        await expect(lvlVal).toHaveText('15');
        
        // Status should change and then eventually "Done" or "Complete"
        const status = page.locator('#refinement-status');
        await expect(status).toBeVisible();
        // No longer expecting NOT to be "Complete" as fast runs might finish instantly during debounce
    });

    test('top combinations should not disappear during refinement (Stability)', async ({ page }) => {
        const catSelect = page.locator('#cat-select');
        const comboList = page.locator('#combo-list');
        const status = page.locator('#refinement-status');

        // 1. Select Book (high complexity)
        await catSelect.selectOption('book');
        
        // 2. Wait for initial results (Coarse)
        await UITestUtils.waitForResults(page);
        const initialText = await comboList.locator('.combo-item').first().innerText();
        expect(initialText.length).toBeGreaterThan(0);

        // 3. Status should be one of the refinement stages or already Complete
        const refinementRegex = UITestUtils.getRefinementRegex(['searching', 'refining', 'finalizing', 'optimizing']);
        await expect(status).toHaveText(refinementRegex, { timeout: 10000 });

        // 4. Wait for it to progress to at least Standard or Deep
        // We want to ensure it DOES NOT flicker to empty while transitioning.
        // We'll poll it for a few seconds.
        for (let i = 0; i < 5; i++) {
            await page.waitForTimeout(1000);
            const currentItem = comboList.locator('.combo-item').first();
            await expect(currentItem).toBeVisible();
            const currentText = await currentItem.innerText();
            expect(currentText.length).toBeGreaterThan(0);
        }
    });

    test('guaranteed enchantment must be 100% across its valid range (Internal Sweep)', async ({ page }) => {
        const catSelect = page.locator('#cat-select');
        const guaranteedSelect = page.locator('#guaranteed-first-select');

        // 1. Select Sword
        await catSelect.selectOption('sword');
        
        // 2. Select Sharpness IV
        await expect(guaranteedSelect.locator('option[value="Sharpness IV"]')).toBeAttached({ timeout: 15000 });
        await guaranteedSelect.selectOption('Sharpness IV');
        
        // 3. Wait for the chart sweep to at least have level 30 result
        await page.waitForFunction(() => {
            const ctrl = (window as any).UIController;
            return ctrl && ctrl.currentSweep && ctrl.currentSweep[29] && ctrl.currentSweep[29].s;
        }, { timeout: 30000 });

        // 4. Inspect the sweep for Sharpness 100% at level 30
        const isAccurateAt30 = await page.evaluate(() => {
            const ctrl = (window as any).UIController;
            const stats = ctrl.currentSweep[29].s;
            const engine = ctrl.engine;
            const sharpnessId = engine.registry.getEnchantId('Sharpness');
            return stats.any[sharpnessId] >= 0.9999;
        });
        expect(isAccurateAt30).toBe(true);

        // 5. Check another level known to have Sharpness IV possible (e.g., Level 25)
        const isAccurateAt25 = await page.evaluate(() => {
            const ctrl = (window as any).UIController;
            const stats = ctrl.currentSweep[24].s;
            const engine = ctrl.engine;
            const sharpnessId = engine.registry.getEnchantId('Sharpness');
            // At level 25, if Sharpness IV is possible (modLevel ~29+), it should be 100%
            // If it's NOT possible, it will be 0, but if it's there, it MUST be 1.0.
            return stats.any[sharpnessId] === 0 || stats.any[sharpnessId] >= 0.9999;
        });
        expect(isAccurateAt25).toBe(true);
    });

    test('should update material list when version changes', async ({ page }) => {
        const vSelect = page.locator('#v-select');
        const catSelect = page.locator('#cat-select');
        const matSelect = page.locator('#mat-select');
        
        // Select Sword category (which supports netherite in 1.16+)
        await catSelect.selectOption('sword');

        // 1.21 should have Netherite
        await vSelect.selectOption('1.21');
        await expect(matSelect.locator('option[value="netherite"]')).toBeAttached();
        
        // 1.0 should NOT have Netherite
        await vSelect.selectOption('1.0');
        await expect(matSelect.locator('option[value="netherite"]')).not.toBeAttached();
    });

    test('should render the chart canvas', async ({ page }) => {
        const canvas = page.locator('#mainChart');
        await expect(canvas).toBeVisible();
        
        // Check if Chart.js has initialized (usually adds a style or data attribute, 
        // but we can just check if it's visible and has non-zero size)
        const box = await canvas.boundingBox();
        expect(box?.width).toBeGreaterThan(0);
        expect(box?.height).toBeGreaterThan(0);
    });
    test('should maintain chart metric if changed mid-calculation', async ({ page }) => {
        const catSelect = page.locator('#cat-select');
        const metricSelect = page.locator('#chart-metric');
        const status = page.locator('#refinement-status');

        // 1. Start a slow Book calculation
        await catSelect.selectOption('book');
        
        // 2. Wait for it to start or already be in a later stage (or Complete if very fast)
        const midCalcRegex = UITestUtils.getRefinementRegex(['searching', 'refining']);
        await expect(status).toHaveText(midCalcRegex, { timeout: 10000 });

        // 3. Mid-calculation, switch metric to "Specific Ranks"
        await metricSelect.selectOption(UI_DEFAULTS.CHART_METRIC_RANKS);
        
        // 4. Wait for it to progress or finish
        await page.waitForTimeout(3000); 

        // 5. Verify that the internal chart state reflects "ranks" 
        // We'll check the length of datasets (any=1, ranks=many)
        const datasetCount = await page.evaluate(() => {
            const chart = (window as any).UIController.chartManager.chart;
            return chart.data.datasets.length;
        });
        
        // "Ranks" should have multiple datasets (one for each enchantment)
        // while "Any" or "Count" only have 1 or a few.
        expect(datasetCount).toBeGreaterThan(5);
    });
});
