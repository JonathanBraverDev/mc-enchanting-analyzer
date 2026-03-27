import { test, expect } from '@playwright/test';
import { UI_TEXTS, UI_DEFAULTS } from '../core/config.js';
import { UITestUtils } from './test-utils.js';

test.describe('UI Performance & Accuracy', () => {
    // Run these in parallel to maximize CPU core usage for heavy engine calls
    test.describe.configure({ mode: 'parallel' });

    test.beforeEach(async ({ page }) => {
        await page.goto('/analyzer.html');
    });

    test('top combinations should not flicker during refinement (Stability)', async ({ page }) => {
        const catSelect = page.locator('#cat-select');
        const comboList = page.locator('#combo-list');
        const status = page.locator('#refinement-status');

        // 1. Trigger Refinement
        await catSelect.selectOption('book');
        
        // 2. Wait for INITIAL results to appear so we have a baseline
        await UITestUtils.waitForResults(page);

        // 3. Setup Flicker Detection for progressive refinement
        await page.evaluate(() => {
            (window as any).__flickerDetected = false;
            const target = document.getElementById('combo-list');
            if (!target) return;
            const observer = new MutationObserver(() => {
                const hasResults = target.querySelectorAll('.combo-names').length > 0;
                const hasPlaceholder = target.querySelectorAll('.combo-placeholder').length > 0;
                
                // If results disappear or are replaced by a placeholder, it's a flicker
                if (!hasResults || hasPlaceholder) {
                    (window as any).__flickerDetected = true;
                }
            });
            observer.observe(target, { childList: true, subtree: true });
            (window as any).__flickerObserver = observer;
        });

        // 4. Wait for full completion
        await expect(status).toHaveText(UI_TEXTS.STATUS_COMPLETE, { timeout: 20000 });

        const flickerDetected = await page.evaluate(() => {
            if ((window as any).__flickerObserver) (window as any).__flickerObserver.disconnect();
            return (window as any).__flickerDetected;
        });
        expect(flickerDetected, 'UI should not flicker/empty during refinement').toBe(false);
    });

    test('guaranteed enchantment (Sword) must be 100% at sample levels (Internal Sweep)', async ({ page }) => {
        const catSelect = page.locator('#cat-select');
        const guaranteedSelect = page.locator('#guaranteed-first-select');

        await catSelect.selectOption('sword');
        await expect(guaranteedSelect.locator('option[value="Sharpness IV"]')).toBeAttached({ timeout: 15000 });
        await guaranteedSelect.selectOption('Sharpness IV');
        
        await page.waitForFunction(() => {
            const ctrl = (window as any).UIController;
            return ctrl && ctrl.currentSweep && ctrl.currentSweep[29] && ctrl.currentSweep[29].s;
        }, { timeout: 30000 });

        const isAccurateAt30 = await page.evaluate(() => {
            const ctrl = (window as any).UIController;
            const stats = ctrl.currentSweep[29].s;
            const engine = ctrl.engine;
            const sharpnessId = engine.registry.getEnchantId('Sharpness');
            return stats.any[sharpnessId] >= 0.9999;
        });
        expect(isAccurateAt30).toBe(true);
    });

    test('guaranteed enchantment (Pickaxe) sweep must be accurate across level 1-30', async ({ page }) => {
        const catSelect = page.locator('#cat-select');
        const guaranteedSelect = page.locator('#guaranteed-first-select');

        await catSelect.selectOption('pickaxe');
        await expect(guaranteedSelect.locator('option[value="Efficiency IV"]')).toBeAttached({ timeout: 15000 });
        await guaranteedSelect.selectOption('Efficiency IV');
        
        await page.waitForFunction(() => {
            const ctrl = (window as any).UIController;
            return ctrl && ctrl.currentSweep && ctrl.currentSweep.length === 30 && ctrl.currentSweep.every((s: any) => s && s.s);
        }, { timeout: 45000 });

        const levelsToTest = [9, 19, 29];
        for (const lIdx of levelsToTest) {
            const result = await page.evaluate((idx) => {
                const ctrl = (window as any).UIController;
                const stats = ctrl.currentSweep[idx].s;
                const engine = ctrl.engine;
                const effId = engine.registry.getEnchantId('Efficiency');
                const prob = stats.any[effId] || 0;
                const isAccurate = prob >= 0.9999 || stats.uncertainty >= 0.9999;
                return { isAccurate, prob, uncertainty: stats.uncertainty };
            }, lIdx);
            expect(result.isAccurate).toBe(true);
        }
    });

    test('guaranteed book enchantment must be exactly 100% in UI', async ({ page }) => {
        const catSelect = page.locator('#cat-select');
        const guaranteedSelect = page.locator('#guaranteed-first-select');
        const status = page.locator('#refinement-status');

        await catSelect.selectOption('book');
        await expect(guaranteedSelect.locator('option[value="Silk Touch I"]')).toBeAttached({ timeout: 15000 });
        await guaranteedSelect.selectOption('Silk Touch I');
        
        // Wait for refinement to complete
        await expect(status).toHaveText(UI_TEXTS.STATUS_COMPLETE, { timeout: 20000 });

        const result = await page.evaluate(() => {
            const ctrl = (window as any).UIController;
            const insights = ctrl.bestInsights;
            if (!insights) return { error: "No insights found" };
            
            const prob = insights.any["Silk Touch"] || 0;
            return { prob };
        });
        
        expect(result.prob, `Silk Touch probability should be 1.0, got ${result.prob}`).toBe(1.0);
    });

    test('should maintain chart metric if changed mid-calculation', async ({ page }) => {
        const catSelect = page.locator('#cat-select');
        const metricSelect = page.locator('#chart-metric');
        const status = page.locator('#refinement-status');

        await catSelect.selectOption('book');
        await expect(status).toHaveText(UITestUtils.getRefinementRegex(['searching', 'refining']), { timeout: 10000 });

        await metricSelect.selectOption(UI_DEFAULTS.CHART_METRIC_RANKS);
        await expect(status).toHaveText(UI_TEXTS.STATUS_COMPLETE, { timeout: 20000 });

        const datasetCount = await page.evaluate(() => {
            return (window as any).UIController.chartManager.chart.data.datasets.length;
        });
        expect(datasetCount).toBeGreaterThan(5);
    });

    test('should handle rapid item/material changes without crashing (Stress)', async ({ page }) => {
        const catSelect = page.locator('#cat-select');
        const matSelect = page.locator('#mat-select');
        
        for (let i = 0; i < 10; i++) {
            const isEven = i % 2 === 0;
            await catSelect.selectOption(isEven ? 'sword' : 'pickaxe');
            if (await matSelect.locator(`option[value="${isEven ? 'gold' : 'diamond'}"]`).count() > 0) {
                await matSelect.selectOption(isEven ? 'gold' : 'diamond');
            }
        }

        await catSelect.selectOption('sword');
        await matSelect.selectOption('gold');
        await UITestUtils.waitForResults(page);
        await expect(page.locator('#combo-list')).toContainText('Sharpness');
    });
});
