import { test, expect } from '@playwright/test';
import { UI_TEXTS, UI_DEFAULTS } from '../core/config.js';
import { UITestUtils } from './test-utils.js';

test.describe('Basic UI Functionality', () => {
    // Run these sequentially for a stable baseline
    test.describe.configure({ mode: 'serial' });

    test.beforeEach(async ({ page }) => {
        await page.goto('/analyzer.html');
    });

    test('should load the page and show initial calculations', async ({ page }) => {
        await expect(page).toHaveTitle(new RegExp(UI_TEXTS.PAGE_TITLE));
        await expect(page.locator('.logo')).toContainText(UI_TEXTS.LOGO_TEXT);
        await UITestUtils.waitForResults(page);
    });

    test('should update calculations when item category changes', async ({ page }) => {
        const catSelect = page.locator('#cat-select');
        const comboList = page.locator('#combo-list');

        await catSelect.selectOption('sword');
        await UITestUtils.waitForResults(page);
        
        await catSelect.selectOption('pickaxe');
        await expect(comboList).toContainText('Efficiency', { timeout: 15000 });
        await expect(comboList).not.toContainText('Sharpness', { timeout: 15000 });
        
        const text = await comboList.innerText();
        expect(text).toContain('Efficiency');
    });

    test('should update calculations when level slider changes', async ({ page }) => {
        const slider = page.locator('#lvl-range');
        const lvlVal = page.locator('#lvl-val');
        await slider.fill('15');
        await expect(lvlVal).toHaveText('15');
    });

    test('should update material list when version changes', async ({ page }) => {
        const vSelect = page.locator('#v-select');
        const catSelect = page.locator('#cat-select');
        const matSelect = page.locator('#mat-select');
        
        await catSelect.selectOption('sword');
        await vSelect.selectOption('1.21');
        await expect(matSelect.locator('option[value="netherite"]')).toBeAttached();
        
        await vSelect.selectOption('1.0');
        await expect(matSelect.locator('option[value="netherite"]')).not.toBeAttached();
    });

    test('should render the chart canvas', async ({ page }) => {
        const canvas = page.locator('#mainChart');
        await expect(canvas).toBeVisible();
        const box = await canvas.boundingBox();
        expect(box?.width).toBeGreaterThan(0);
    });
});
