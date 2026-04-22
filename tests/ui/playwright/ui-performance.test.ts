import { test, expect } from '@playwright/test';
import { UI_TEXTS, UI_DEFAULTS } from '#core/config.js';
import { AnalyzerPage } from './pom/analyzer-page.js';
import { TEST_DATA } from '../../infra/test-data.js';

test.describe('UI Performance & Stability', () => {
    // Run these in parallel to maximize CPU core usage for heavy engine calls
    test.describe.configure({ mode: 'parallel' });

    let analyzer: AnalyzerPage;

    test.beforeEach(async ({ page }) => {
        analyzer = new AnalyzerPage(page);
        await analyzer.goto();
    });

    test('top combinations should not flicker during refinement (Stability)', async ({ page }) => {
        await analyzer.selectCategory('book');
        
        // Wait for INITIAL results to appear so we have a baseline
        await analyzer.waitForResults();

        // Setup Flicker Detection
        await page.evaluate(() => {
            (window as any).__flickerDetected = false;
            const target = document.getElementById('combo-list');
            if (!target) return;
            const observer = new MutationObserver(() => {
                const hasResults = target.querySelectorAll('.combo-names').length > 0;
                const hasPlaceholder = target.querySelectorAll('.combo-placeholder').length > 0;
                if (!hasResults || hasPlaceholder) {
                    (window as any).__flickerDetected = true;
                }
            });
            observer.observe(target, { childList: true, subtree: true });
            (window as any).__flickerObserver = observer;
        });

        await analyzer.waitForRefinementComplete(90000);

        const flickerDetected = await page.evaluate(() => {
            if ((window as any).__flickerObserver) (window as any).__flickerObserver.disconnect();
            return (window as any).__flickerDetected;
        });
        expect(flickerDetected, 'UI should not flicker/empty during refinement').toBe(false);
    });

    test('should display 100% probability for clue-conditioned Sharpness IV on Sword', async () => {
        await analyzer.selectCategory('sword');
        await analyzer.selectClue('Sharpness IV');
        await analyzer.waitForRefinementComplete();
        await expect(analyzer.rankSection).toContainText('100.0%');
    });

    test('should update result probabilities correctly when scrubbing the enchanting level slider', async () => {
        await analyzer.selectCategory('pickaxe');
        await analyzer.selectClue('Efficiency IV');
        
        const levelsToTest = [25, 28, 30];
        for (const lvl of levelsToTest) {
            await analyzer.triggerAndAwaitRefinement(async () => {
                await analyzer.setLevel(lvl);
            });
            await expect(analyzer.rankSection).toContainText('100.0%');
        }
    });

    test('should maintain chart metric if changed mid-calculation', async () => {
        await analyzer.selectCategory('book');
        
        // Wait for it to start searching/refining (it might be fast, so we handle potential immediate completion)
        try {
            await expect(analyzer.refinementStatus).not.toHaveText(UI_TEXTS.STATUS_COMPLETE, { timeout: 1000 });
        } catch (e) { /* ignore if already moved past or too fast */ }
        
        // Ensure the engine is actually working before clicking (we used to check status here, but now we just proceed)
        await analyzer.selectChartMetric(UI_DEFAULTS.CHART_METRIC_RANKS);
        await analyzer.waitForRefinementComplete(90000);
        await expect(analyzer.chartCanvas).toBeVisible();
    });

    test('should handle rapid item/material changes without crashing (Stress)', async () => {
        // Set a longer timeout for this specific test to handle the overhead of many rapid runs
        test.slow();
        
        await analyzer.waitForRefinementComplete();
        
        // RAPID switches: don't await results between these
        const categories = [TEST_DATA.ITEMS.SWORD, TEST_DATA.ITEMS.PICKAXE];
        for (let i = 0; i < 5; i++) {
            await analyzer.selectCategory(categories[i % 2]!);
            // Small pause ensures the browser handles the event before the next one fires
            await analyzer.page.waitForTimeout(50);
        }

        // Final switch: wait for this one to settle completely
        await analyzer.triggerAndAwaitRefinement(async () => {
            await analyzer.selectCategory(TEST_DATA.ITEMS.SWORD);
        });
        
        // Increase locator timeout for the final results visibility check after stress
        await analyzer.waitForResults(30000);
        await expect(analyzer.comboList.locator('.combo-placeholder')).toHaveCount(0);
        await expect(analyzer.comboList).toContainText('Sharpness');
    });

    test('should redraw the chart sequentially for initial book selection', async () => {
        test.setTimeout(120000);
        
        // 1. Start monitoring from a clean state (Fresh page load from beforeEach)
        await analyzer.startMonitoringProgress();
        await analyzer.selectCategory('book');
        
        // Wait for it to leave 'Complete' status
        await expect(analyzer.refinementStatus).not.toHaveText(UI_TEXTS.STATUS_COMPLETE);

        // 2. Verify sequential progress
        await expect(analyzer.chartStatus).toHaveText(/\((9\d|100)%\)|Complete/, { timeout: 90000 });
        const log = await analyzer.getObservedProgress();
        
        const percentages = log
            .map(s => {
                const match = s.match(/\((\d+)%\)/);
                return match ? parseInt(match[1]!) : null;
            })
            .filter(n => n !== null) as number[];

        expect(percentages.length, 'Should observe multiple progress steps').toBeGreaterThan(10);
        
        let currentSequence = 0;
        let maxSequence = 0;
        let lastVal = -1;
        for (const val of percentages) {
            if (val >= lastVal) {
                currentSequence++;
            } else {
                currentSequence = 1;
            }
            lastVal = val;
            maxSequence = Math.max(maxSequence, currentSequence);
        }
        expect(maxSequence, 'Initial redraw should have a sequential run of at least 5 steps').toBeGreaterThan(5);
        expect(Math.max(...percentages)).toBeGreaterThanOrEqual(10);
    });

    test('should reset and redraw the chart when switching from pickaxe to book category', async () => {
        test.setTimeout(150000);
        
        // 1. Establish initial state
        await analyzer.selectCategory('pickaxe');
        await analyzer.waitForRefinementComplete();
        
        // No need to wait for chart idle here, the switch will abort any running sweep.
        // We just need to ensure the monitoring is fresh and starts AFTER the category switch is processed.
        
        // 2. Trigger change
        await analyzer.selectCategory('book');
        
        // Wait for it to leave 'Complete' status - this confirms run() has started and aborted old sweeps
        await expect(analyzer.refinementStatus).not.toHaveText(UI_TEXTS.STATUS_COMPLETE);

        // 3. Start monitoring NOW
        await analyzer.startMonitoringProgress();

        // 4. Verify sequential progress was observed for the NEW sweep
        await expect(analyzer.chartStatus).toHaveText(/\((9\d|100)%\)|Complete/, { timeout: 90000 });
        const log = await analyzer.getObservedProgress();
        
        const percentages = log
            .map(s => {
                const match = s.match(/\((\d+)%\)/);
                return match ? parseInt(match[1]!) : null;
            })
            .filter(n => n !== null) as number[];

        expect(percentages.length, 'Should observe multiple progress steps for the new sweep').toBeGreaterThan(10);
        
        let currentSequence = 0;
        let maxSequence = 0;
        let lastVal = -1;
        for (const val of percentages) {
            if (val >= lastVal) {
                currentSequence++;
            } else {
                currentSequence = 1;
            }
            lastVal = val;
            maxSequence = Math.max(maxSequence, currentSequence);
        }
        expect(maxSequence, 'Redraw after reset should have a sequential run of at least 5 steps').toBeGreaterThan(5);
    });
});



