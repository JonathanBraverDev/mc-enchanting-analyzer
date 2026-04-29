import { test, expect } from '@playwright/test';
import { UI_TEXTS } from '../core/config.js';

/**
 * Regression test for Chart Loading behavior.
 * Verifies that the chart loads level-by-level (linear ordering) 
 * and that the final refinement pass improves the chart's accuracy.
 */
test.describe('Chart Loading Regression', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/analyzer.html');
    });

    test('should load chart sequentially and refine probabilities for books', async ({ page }) => {
        test.setTimeout(60000);
        const catSelect = page.locator('#cat-select');

        // 1. Setup a "Spy" to intercept chart updates
        // We'll record which level was just updated by comparing the sweep against the last seen state.
        await page.evaluate(() => {
            const ctrl = (window as any).UIController;
            if (!ctrl) return;
            
            (window as any).chartPopulatedLog = [];
            const originalRefresh = ctrl.chart.refresh.bind(ctrl.chart);
            let lastSweep: any[] = [];
            
            ctrl.chart.refresh = (sweep: any[], registry: any) => {
                // Find the index that was just updated
                const updatedIndex = sweep.findIndex((s, i) => s !== lastSweep[i]);
                if (updatedIndex !== -1) {
                    (window as any).chartPopulatedLog.push(updatedIndex + 1);
                }
                lastSweep = [...sweep];
                return originalRefresh(sweep, registry);
            };
        });

        await test.step('Step 1: Initialization', async () => {
            // Setup for Book (high complexity, best for observing sweep)
            await catSelect.selectOption('book');
        });
        
        await test.step('Step 2: Sequential Coarse Sweep', async () => {
            // Wait for the coarse pass to complete all 30 levels
            await page.waitForFunction(() => {
                const ctrl = (window as any).UIController;
                return ctrl && ctrl.currentSweep && ctrl.currentSweep.every((s: any) => s !== null);
            }, { timeout: 40000 });

            // Verify linear trace for the first pass (1->30)
            const log = await page.evaluate(() => (window as any).chartPopulatedLog as number[]);
            let lastValue = 0;
            let foundLinear30 = false;
            for (const val of log) {
                if (val === lastValue + 1) {
                    lastValue = val;
                } else if (val === 1) { 
                    lastValue = 1;
                }
                if (lastValue === 30) {
                    foundLinear30 = true;
                    break;
                }
            }
            expect(foundLinear30, `Coarse pass should follow a linear 1->30 trace. Captured Log: ${log}`).toBe(true);
        });

        let coarseSweep: any[] = [];
        await test.step('Step 3: Coarse Baseline Collection', async () => {
            coarseSweep = await page.evaluate(() => {
                const ctrl = (window as any).UIController;
                return ctrl.currentSweep.map((s: any) => ({
                    uncertainty: s.s.uncertainty,
                    anyCount: Object.keys(s.s.any).length
                }));
            });
        });

        await test.step('Step 4: Multi-Pass Sweeps', async () => {
            // For books, we expect at least 2 full sweeps (Initial Coarse + Final Ultra).
            // Middle passes (Standard/Deep) may be skipped if they are superseded.
            await page.waitForFunction(() => {
                const log = (window as any).chartPopulatedLog as number[];
                if (!log) return false;
                
                let sweeps = 0;
                let last = 0;
                for (const v of log) {
                    if (v === last + 1) {
                        last = v;
                        if (last === 30) {
                            sweeps++;
                            last = 0;
                        }
                    } else if (v === 1) {
                        last = 1;
                    }
                }
                return sweeps >= 2;
            }, { timeout: 90000 });

            const log = await page.evaluate(() => (window as any).chartPopulatedLog as number[]);
            
            let completeSweeps = 0;
            let lastValue = 0;
            for (const val of log) {
                if (val === lastValue + 1) {
                    lastValue = val;
                    if (lastValue === 30) {
                        completeSweeps++;
                        lastValue = 0; 
                    }
                } else if (val === 1) {
                    lastValue = 1;
                }
            }
            
            expect(completeSweeps, `Should have completed at least 2 full linear sweeps. Captured Log: ${log}`).toBeGreaterThanOrEqual(2);
        });

        await test.step('Step 5: Accuracy Refinement', async () => {
            const finalSweep = await page.evaluate(() => {
                const ctrl = (window as any).UIController;
                return ctrl.currentSweep.map((s: any) => ({
                    uncertainty: s.s.uncertainty,
                    anyCount: Object.keys(s.s.any).length
                }));
            });

            let refinedLevels = 0;
            for (let i = 0; i < 30; i++) {
                // The ultra pass should reduce uncertainty or find more specific enchantments
                if (finalSweep[i].uncertainty < coarseSweep[i].uncertainty - 0.000001 || 
                    finalSweep[i].anyCount > coarseSweep[i].anyCount) {
                    refinedLevels++;
                }
            }

            expect(refinedLevels, 'The ultra pass should refine the accuracy of at least some chart levels').toBeGreaterThan(0);
        });
    });
});
