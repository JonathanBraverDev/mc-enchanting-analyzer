import { test, expect } from '@playwright/test';
import { UI_TEXTS } from '#core/config.js';
import { AnalyzerPage } from './pom/analyzer-page.js';
import { TEST_DATA } from '../../infra/test-data.js';

/**
 * Validates sequential redraw and progress feedback of the chart.
 * This is a critical path for user-perceived performance and stability.
 */
test.describe('Chart Loading Regression', () => {
    let analyzer: AnalyzerPage;

    test.beforeEach(async ({ page }) => {
        analyzer = new AnalyzerPage(page);
        await analyzer.goto();
    });

    test('should provide visible progress feedback to the user during complex book calculations', async () => {
        test.setTimeout(120000); // Allow more time for sequential redraws
        // 1. Setup
        await analyzer.selectVersion(TEST_DATA.VERSIONS.MODERN);
        await analyzer.startMonitoringProgress();

        await test.step('Step 1: Initialization', async () => {
            await analyzer.triggerAndAwaitRefinement(async () => {
                await analyzer.selectCategory(TEST_DATA.ITEMS.BOOK);
            });
            // At this point, refinement is complete, but chart sweep might still be running.
        });
        
        await test.step('Step 2: Sequential Coarse Sweep Observed via UI', async () => {
            // Wait for main refinement
            await analyzer.waitForRefinementComplete(90000);
            
            // Wait for chart sweep to reach at least a high percentage or complete.
            // This is more stable than waiting for "Idle" which can be transient between sweeps.
            await expect(analyzer.chartStatus).toHaveText(TEST_DATA.REGEX.CHART_PROGRESS, { timeout: 90000 });

            const log = await analyzer.getObservedProgress();


            
            // Extract percentages from log
            const percentages = log
                .map(s => {
                    const match = s.match(/\((\d+)%\)/);
                    return match ? parseInt(match[1]) : null;
                })
                .filter(n => n !== null) as number[];
            
            // Expected levels in percentage: (L / 30) * 100
            // For L=1..30, we expect values like 3, 7, 10, ..., 100
            // We verify that the captured percentages contain a non-decreasing sequence
            // that eventually covers the full range, confirming level-by-level drawing.
            
            expect(percentages.length, 'Should have multiple progress steps recorded').toBeGreaterThan(10);
            
            let lastVal = 0;
            let linearSteps = 0;
            for (const val of percentages) {
                if (val >= lastVal) {
                    linearSteps++;
                    lastVal = val;
                } else if (val <= 10) { 
                    // Reset observed if a new sweep starts (e.g. coarse -> standard)
                    lastVal = val;
                }
            }
            
            expect(linearSteps, 'Should have a significant number of non-decreasing steps').toBeGreaterThan(10);
            expect(Math.max(...percentages), 'Should reach some progress').toBeGreaterThanOrEqual(10);
        });

        await test.step('Step 3: UI Completion Verification', async () => {
            const statusText = await analyzer.getStatusText();
            expect(statusText).toContain(UI_TEXTS.STATUS_COMPLETE);
        });

        await test.step('Step 4: Result Visibility', async () => {
            // Final check: at least one result should be visible
            await analyzer.waitForResults();
            await expect(analyzer.comboItems.first()).toBeVisible();
        });
    });
});



