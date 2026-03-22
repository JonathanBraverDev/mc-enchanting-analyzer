import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert';
import { UI_TEXTS } from './config.js';
import { ResultProcessor } from './utils/index.js';
import { EnchantEngine } from './engine.js';


/**
 * Utility for snapshot-based regression testing of engine results.
 */
export const SnapshotUtils = {
    /**
     * Compares a set of statistics against a saved snapshot.
     */
    async assertSnapshot(name: string, stats: any): Promise<void> {
        const snapshotDir = path.resolve(process.cwd(), 'tests', 'snapshots');
        const snapshotPath = path.join(snapshotDir, `${name}.json`);

        if (!fs.existsSync(snapshotPath)) {
            throw new Error(`Snapshot "${name}" not found at ${snapshotPath}. Run the update-snapshots script first.`);
        }

        const cleanStats = this.sanitize(stats);
        const existing = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        
        try {
            assert.deepStrictEqual(cleanStats, existing);
        } catch (e: any) {
            const diffPath = path.join(snapshotDir, `${name}.actual.json`);
            fs.writeFileSync(diffPath, JSON.stringify(cleanStats, null, 2));
            throw new Error(`Snapshot mismatch for "${name}". Actual result saved to ${diffPath}`);
        }
    },

    /**
     * Saves a set of statistics as a snapshot.
     */
    async saveSnapshot(name: string, stats: any): Promise<void> {
        const snapshotDir = path.resolve(process.cwd(), 'tests', 'snapshots');
        const snapshotPath = path.join(snapshotDir, `${name}.json`);

        if (!fs.existsSync(snapshotDir)) {
            fs.mkdirSync(snapshotDir, { recursive: true });
        }

        const cleanStats = this.sanitize(stats);
        fs.writeFileSync(snapshotPath, JSON.stringify(cleanStats, null, 2));
        console.log(`Snapshot saved: ${name}`);
    },

    /**
     * Sanitizes stats to ensure deterministic comparison.
     * Truncates probabilities to a reasonable precision to avoid floating point noise.
     */
    sanitize(stats: any): any {
        const round = (val: number) => Math.round(val * 1e12) / 1e12;
        const out: any = {
            ranks: {},
            any: {},
            count: {},
            combos: {},
            uncertainty: round(stats.uncertainty)
        };

        if (stats.combos) {
            for (const k in stats.combos) out.combos[k] = round(stats.combos[k]);
        }
        if (stats.ranks) {
            for (const k in stats.ranks) out.ranks[k] = round(stats.ranks[k]);
        }
        if (stats.any) {
            for (const k in stats.any) out.any[k] = round(stats.any[k]);
        }
        if (stats.count) {
            for (const k in stats.count) out.count[k] = round(stats.count[k]);
        }
        return out;
    }
};

/**
 * Utilities for Playwright-based UI tests.
 */
export const UITestUtils = {
    /**
     * Generates a regex that matches any of the provided status levels or "Complete".
     */
    getRefinementRegex(levels: string[]): RegExp {
        const parts = levels.map(level => (UI_TEXTS as any)[`STATUS_${level.toUpperCase()}`] || level);
        if (!parts.includes(UI_TEXTS.STATUS_COMPLETE)) parts.push(UI_TEXTS.STATUS_COMPLETE);
        return new RegExp(parts.join('|'));
    },

    /**
     * Waits for the first enchantment combination to appear in the UI.
     */
    async waitForResults(page: any, timeout = 15000): Promise<void> {
        await page.locator('#combo-list .combo-item').first().waitFor({ state: 'visible', timeout });
    },

    /**
     * Accesses the internal UIController state from the browser context.
     */
    async getInternalState(page: any): Promise<any> {
        return await page.evaluate(() => (window as any).UIController);
    }
};

/**
 * Utilities for Node-based engine tests.
 */
export const EngineTestUtils = {
    /**
     * Performs a full enchantment simulation and returns human-readable results.
     */
    async getHumanStats(engine: EnchantEngine, cat: string, xp: number, mat: string, guaranteedFirst: string | null = null, threshold = 0.0001): Promise<any> {
        const stats = await engine.getFullStats(cat, xp, mat, guaranteedFirst, threshold);
        return ResultProcessor.humanize(stats, engine.registry);
    }
};
