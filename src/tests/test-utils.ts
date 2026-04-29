import * as fs from 'node:fs';
import * as path from 'node:path';
import { HumanizationService } from '../services/index.js';
import { EnchantEngine } from '../engine/index.js';

/**
 * Utility for snapshot-based regression testing of engine results.
 */
export const SnapshotUtils = {
    /**
     * Compares a set of statistics against a saved snapshot.
     */
    async assertSnapshot(name: string, stats: any): Promise<void> {
        const snapshotDir = path.resolve(process.cwd(), 'src', 'tests', 'snapshots');
        const snapshotPath = path.join(snapshotDir, `${name}.json`);

        if (!fs.existsSync(snapshotPath)) {
            throw new Error(`Snapshot "${name}" not found at ${snapshotPath}. Run the update-snapshots script first.`);
        }

        const cleanStats = this.sanitize(stats);
        const existing = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        
        const summary = this.computeStatisticalSummary(cleanStats, existing);
        if (summary.hasMismatches) {
            const diffPath = path.join(snapshotDir, `${name}.actual.json`);
            fs.writeFileSync(diffPath, JSON.stringify(cleanStats, null, 2));
            
            const errorMessage = `Snapshot mismatch for "${name}".\n${summary.report}\nActual result saved to ${diffPath}`;
            
            const error = new Error(errorMessage);
            // Suppress the redundant stack trace
            error.stack = errorMessage;
            throw error;
        }
    },

    /**
     * Performs a memory-efficient statistical analysis of snapshot differences.
     */
    computeStatisticalSummary(actual: any, expected: any): { hasMismatches: boolean; report: string } {
        let hasMismatches = false;
        const sections: string[] = [];

        // Check top-level metadata (e.g., accuracy)
        if (actual.accuracy !== expected.accuracy) {
            hasMismatches = true;
            sections.push(`[metadata]: Accuracy mismatch. Expected ${expected.accuracy}, got ${actual.accuracy}`);
        }

        // Check probability categories
        const categories = ['ranks', 'any', 'count', 'combos'];
        for (const cat of categories) {
            const report = this.compareProbabilityMap(actual[cat] || {}, expected[cat] || {}, cat);
            if (report.hasMismatches) {
                hasMismatches = true;
                sections.push(report.text);
            }
        }

        return {
            hasMismatches,
            report: sections.join('\n\n')
        };
    },

    /**
     * Compares two flat probability maps and returns a statistical summary.
     */
    compareProbabilityMap(actual: Record<string, number>, expected: Record<string, number>, name: string) {
        let hasMismatches = false;
        let maxDelta = 0;
        let maxDeltaKey = '';
        let sse = 0; // Sum of Squared Errors
        const outliers: { key: string; delta: number; expected: number; actual: number }[] = [];
        
        const aKeys = Object.keys(actual);
        const eKeys = Object.keys(expected);
        const missing = eKeys.filter(k => !(k in actual));
        const extra = aKeys.filter(k => !(k in expected));

        if (missing.length > 0 || extra.length > 0) {
            hasMismatches = true;
        }

        for (const key of eKeys) {
            if (!(key in actual)) continue;
            
            const aVal = actual[key];
            const eVal = expected[key];
            const delta = Math.abs(aVal - eVal);

            if (delta > 0) {
                hasMismatches = true;
                sse += delta * delta;
                if (delta > maxDelta) {
                    maxDelta = delta;
                    maxDeltaKey = key;
                }
                
                // Track top outliers
                if (outliers.length < 5 || delta > outliers[outliers.length - 1].delta) {
                    outliers.push({ key, delta, expected: eVal, actual: aVal });
                    outliers.sort((a, b) => b.delta - a.delta);
                    if (outliers.length > 5) outliers.pop();
                }
            }
        }

        if (!hasMismatches) return { hasMismatches: false, text: '' };

        const lines: string[] = [`Category [${name}]: ${eKeys.length} keys`];
        if (missing.length > 0) lines.push(`  - Missing: ${missing.length} keys (e.g., ${missing.slice(0, 3).join(', ')})`);
        if (extra.length > 0) lines.push(`  - Extra: ${extra.length} keys (e.g., ${extra.slice(0, 3).join(', ')})`);
        
        if (maxDelta > 0) {
            lines.push(`  - Max Delta: ${maxDelta.toExponential(2)} (at "${maxDeltaKey}")`);
            lines.push(`  - RMSE: ${Math.sqrt(sse / eKeys.length).toExponential(2)}`);
            lines.push(`  - Top Outliers:`);
            for (const o of outliers) {
                lines.push(`    * ${o.key}: exp ${o.expected}, got ${o.actual} (Δ ${o.delta.toExponential(2)})`);
            }
        }

        return { hasMismatches: true, text: lines.join('\n') };
    },

    /**
     * Saves a set of statistics as a snapshot.
     */
    async saveSnapshot(name: string, stats: any): Promise<void> {
        const snapshotDir = path.resolve(process.cwd(), 'src', 'tests', 'snapshots');
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
        const roundMap = (obj: any) => {
            const res: any = {};
            for (const k in obj) res[k] = round(obj[k]);
            return res;
        };

        return {
            ranks: roundMap(stats.ranks),
            any: roundMap(stats.any),
            count: roundMap(stats.count),
            combos: roundMap(stats.combos),
            accuracy: round(stats.accuracy),
            accounting: stats.accounting
        };
    }
};

/** Assertion timeout scaled for CI runners. */
export const UI_TIMEOUT = process.env.CI ? 45000 : 15000;

/**
 * Utilities for Node-based engine tests.
 */
export const EngineTestUtils = {
    /**
     * Performs a full enchantment simulation and returns human-readable results.
     */
    async getHumanStats(engine: EnchantEngine, cat: string, xp: number, mat: string, guaranteedFirst: string | null = null, threshold = 0.0001): Promise<any> {
        const stats = await engine.getFullStats(cat, xp, mat, { guaranteedFirst, threshold });
        return HumanizationService.humanize(stats, engine.registry);
    }
};
