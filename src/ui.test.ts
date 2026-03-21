import { test, expect } from '@playwright/test';

test.describe('Enchantment Analyzer UI', () => {
    
    test.beforeEach(async ({ page }) => {
        await page.goto('/analyzer.html');
    });

    test('should load the page and show initial calculations', async ({ page }) => {
        await expect(page).toHaveTitle(/Minecraft Enchantment Analyzer/);
        await expect(page.locator('.logo')).toContainText('Analyzer');
        
        // Wait for worker to be ready (UI should show "Coarse" or "Standard" refinement)
        const status = page.locator('#refinement-status');
        await expect(status).toBeVisible();
        
        // Check for top combinations
        const comboList = page.locator('#combo-list');
        await expect(comboList.locator('.combo-item').first()).toBeVisible({ timeout: 15000 });
    });

    test('should update calculations when item category changes', async ({ page }) => {
        const catSelect = page.locator('#cat-select');
        const comboList = page.locator('#combo-list');

        // 1. Start with Sword
        await catSelect.selectOption('sword');
        await expect(comboList.locator('.combo-item').first()).toBeVisible({ timeout: 15000 });
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
        
        // Initial value is 30
        await expect(lvlVal).toHaveText('30');
        
        // Move slider to 15
        await slider.fill('15');
        await expect(lvlVal).toHaveText('15');
        
        // Status should change to "Coarse" and then eventually "Done" or "Complete"
        const status = page.locator('#refinement-status');
        await expect(status).not.toHaveText('Complete'); // Should at least flicker to a different state
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
});
