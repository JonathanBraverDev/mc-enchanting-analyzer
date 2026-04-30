import { Page, Locator, expect } from '@playwright/test';
import { UI_TEXTS } from '#core/config.js';
import { UI_TIMEOUT } from '#tests/infra/test-utils.js';

export class AnalyzerPage {
    readonly page: Page;
    
    // Locators
    readonly versionSelect: Locator;
    readonly categorySelect: Locator;
    readonly materialSelect: Locator;
    readonly clueSelect: Locator;
    readonly levelSlider: Locator;
    readonly levelValue: Locator;
    readonly enchantabilityValue: Locator;
    
    readonly chartCanvas: Locator;
    readonly chartStatus: Locator;
    readonly chartMetricSelect: Locator;
    
    readonly refinementStatus: Locator;
    readonly comboSortSelect: Locator;
    readonly comboList: Locator;
    readonly comboItems: Locator;
    readonly rankSection: Locator;

    constructor(page: Page) {
        this.page = page;
        
        // Using getByLabel where possible for better accessibility/resilience
        this.versionSelect = page.getByLabel('Version');
        this.categorySelect = page.getByLabel('Item Category');
        this.materialSelect = page.getByLabel('Material');
        this.clueSelect = page.getByLabel('Shown in Table');
        
        // Level slider label contains dynamic text, so we use the slider role or specific text
        this.levelSlider = page.getByRole('slider');
        this.levelValue = page.locator('#lvl-val'); // Specific ID for the displayed value
        this.enchantabilityValue = page.locator('#ench-val');

        this.chartCanvas = page.locator('#mainChart');
        this.chartStatus = page.locator('#chart-status');
        this.chartMetricSelect = page.locator('#chart-metric');

        this.refinementStatus = page.locator('#refinement-status');
        this.comboSortSelect = page.locator('#combo-sort');
        this.comboList = page.locator('#combo-list');
        this.comboItems = page.locator('#combo-list .combo-item');
        this.rankSection = page.locator('#rank-section');
    }

    async goto() {
        await this.page.goto('/src/ui/analyzer.html');
    }

    async selectCategory(category: string) {
        await this.categorySelect.selectOption(category);
    }

    async selectVersion(version: string) {
        // Playwright's selectOption has built-in waiting for the option
        await this.versionSelect.selectOption(version);
    }

    async selectMaterial(material: string) {
        await this.materialSelect.selectOption(material);
    }

    async selectClue(enchantment: string) {
        await this.clueSelect.selectOption(enchantment);
    }

    async setLevel(level: number) {
        await this.levelSlider.evaluate((el: HTMLInputElement, val) => {
            el.value = val.toString();
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, level);
    }

    async selectChartMetric(metric: string) {
        await this.chartMetricSelect.selectOption(metric);
    }

    async selectComboSort(sort: string) {
        await this.comboSortSelect.selectOption(sort);
    }

    /**
     * Helper to wait for the refinement status to reach "Complete".
     */
    async waitForRefinementComplete(timeout = UI_TIMEOUT * 2) {
        await expect(this.refinementStatus).toHaveText(UI_TEXTS.STATUS_COMPLETE, { timeout });
    }

    /**
     * Executes an action that triggers a new calculation and waits for it to complete robustly.
     */
    async triggerAndAwaitRefinement(action: () => Promise<void>, timeout = UI_TIMEOUT * 2) {
        // Perform the action
        await action();
        
        // Wait for it to become 'Scanning...' (it might be very fast, so we handle that)
        try {
            await expect(this.refinementStatus).not.toHaveText(UI_TEXTS.STATUS_COMPLETE, { timeout: 1000 });
        } catch (e) {
            // Already complete or too fast
        }
        
        await this.waitForRefinementComplete(timeout);
    }


    /**
     * Waits for at least one result to appear in the combo list.
     */
    async waitForResults(timeout = UI_TIMEOUT) {
        // Wait for items to appear and be visible
        await this.comboItems.first().waitFor({ state: 'visible', timeout });
        // Also ensure placeholder is gone
        await expect(this.comboList.locator('.combo-placeholder')).toHaveCount(0, { timeout });
    }

    /**
     * Gets the current refinement status text.
     */
    async getStatusText() {
        return await this.refinementStatus.textContent();
    }

    /**
     * Checks if a placeholder is visible in the combo list.
     */
    async isPlaceholderVisible() {
        return await this.comboList.locator('.combo-placeholder').isVisible();
    }

    /**
     * Helper to wait for the chart status to indicate progress or completion.
     */
    async waitForChartProgress(regex: RegExp, timeout = UI_TIMEOUT) {
        await expect(this.chartStatus).toHaveText(regex, { timeout });
    }

    /**
     * Starts monitoring changes to the chart status text (used to verify sequential redraws).
     */
    async startMonitoringProgress() {
        await this.page.evaluate(() => {
            (window as any)._uiProgressLog = [];
            const target = document.getElementById('chart-status');
            if (!target) return;
            const observer = new MutationObserver(() => {
                const text = target.textContent || "";
                (window as any)._uiProgressLog.push(text);
            });
            observer.observe(target, { childList: true, characterData: true, subtree: true });
            (window as any)._uiProgressObserver = observer;
        });
    }

    /**
     * Stops monitoring and returns the log of observed progress strings.
     */
    async getObservedProgress(): Promise<string[]> {
        return await this.page.evaluate(() => {
            if ((window as any)._uiProgressObserver) {
                (window as any)._uiProgressObserver.disconnect();
            }
            return (window as any)._uiProgressLog || [];
        });
    }

    /**
     * Waits for the chart worker to be idle (indicated by empty status text).
     */
    async waitForChartIdle(timeout = UI_TIMEOUT * 2) {
        // Either empty or "Complete" is a settled terminal state
        await expect(this.chartStatus).toHaveText(/^$|Complete/, { timeout });
    }
}






