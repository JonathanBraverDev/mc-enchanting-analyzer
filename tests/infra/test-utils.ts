import * as fs from 'node:fs';
import * as path from 'node:path';
import { HumanizationService } from '#services/index.js';
import { EnchantEngine } from '#engine/index.js';
import type { EnchantStats, CheckpointSearchRequest } from '#types/index.js';

const SNAPSHOT_ROUNDING_SCALE = 1e12;
const MASS_BUCKET_ORDER = [
    'resolved',
    'clueIncompatible',
    'pending',
    'sieved',
    'overflow',
    'capped',
    'rounding',
    'recoveredRounding',
    'recoveredSieved',
    'source',
    'projected',
    'loss'
];
const MASS_STAGE_ORDER = ['search', 'projection'];
const MASS_OPERATION_ORDER = [
    'seed',
    'frontier',
    'resolve',
    'clueIncompatible',
    'edgeSplit',
    'overflow',
    'sieve',
    'residue',
    'cap',
    'results',
    'pending'
];
const SNAPSHOT_ENGINE_DIAGNOSTIC_KEYS = [
    'totalIterations',
    'roundingErrorEvents',
    'levelsProcessed',
    'levelsFullyResolved',
    'fullyResolved',
    'resultsSize',
    'queueSize',
    'exitReason'
];
const SNAPSHOT_SEARCH_DIAGNOSTIC_KEYS = [
    'graphCount',
    'seededLevelCount',
    'pendingEntryCount',
    'largestPendingMass',
    'lastExpandedMass',
    'activeResidueCount',
    'activeResidueMass',
    'canImprove',
    'flexStateIdentityMode',
    'flexSolidNodeCount',
    'flexPlexNodeCount',
    'flexSingletonGroupCount',
    'flexChoiceGroupCount',
    'flexGroupedAlternativeCount',
    'flexExpandedSolidNodeCount',
    'flexExpandedPlexNodeCount',
    'flexProjectionLoss',
    'flexProjectionClueIncompatible'
];

function roundSnapshotProbability(val: number): number {
    return Math.round(val * SNAPSHOT_ROUNDING_SCALE) / SNAPSHOT_ROUNDING_SCALE;
}

function orderedKeys(obj: Record<string, unknown> | undefined, preferredOrder: readonly string[]): string[] {
    if (!obj) return [];
    const preferred = preferredOrder.filter(key => Object.prototype.hasOwnProperty.call(obj, key));
    const preferredSet = new Set(preferred);
    const remaining = Object.keys(obj)
        .filter(key => !preferredSet.has(key))
        .sort((a, b) => a.localeCompare(b));
    return [...preferred, ...remaining];
}

function pickOrderedFields(obj: any, keys: readonly string[]): any | undefined {
    if (!obj) return undefined;
    const out: any = {};
    for (const key of keys) {
        if (obj[key] !== undefined) out[key] = typeof obj[key] === 'number' ? roundSnapshotProbability(obj[key]) : obj[key];
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function sortDetailBuckets(buckets: any): any {
    const out: any = {};
    for (const key of orderedKeys(buckets, MASS_BUCKET_ORDER)) {
        const bucket = buckets[key];
        out[key] = {
            value: bucket.value,
            units: bucket.units
        };
    }
    return out;
}

function sortMassDetails(details: any): any | undefined {
    if (!details) return undefined;
    const stages: any = {};
    for (const stageKey of orderedKeys(details.stages, MASS_STAGE_ORDER)) {
        const stage = details.stages[stageKey];
        const operations: any = {};
        for (const operationKey of orderedKeys(stage.operations, MASS_OPERATION_ORDER)) {
            operations[operationKey] = {
                buckets: sortDetailBuckets(stage.operations[operationKey].buckets)
            };
        }
        stages[stageKey] = {
            buckets: sortDetailBuckets(stage.buckets),
            operations
        };
    }
    return { stages };
}

function sortAccounting(accounting: any): any {
    if (!accounting) return accounting;
    const out: any = {};
    const reserved = new Set(['units', 'details']);
    for (const bucket of MASS_BUCKET_ORDER) {
        if (accounting[bucket] !== undefined) out[bucket] = accounting[bucket];
        reserved.add(bucket);
    }
    for (const key of Object.keys(accounting).filter(key => !reserved.has(key)).sort((a, b) => a.localeCompare(b))) {
        out[key] = accounting[key];
    }
    if (accounting.units) {
        const units: any = {};
        for (const bucket of orderedKeys(accounting.units, MASS_BUCKET_ORDER)) units[bucket] = accounting.units[bucket];
        out.units = units;
    }
    if (accounting.details) out.details = sortMassDetails(accounting.details);
    return out;
}

function sanitizeDiagnostics(instrumentation: any): any | undefined {
    if (!instrumentation) return undefined;
    const engine = pickOrderedFields(instrumentation, SNAPSHOT_ENGINE_DIAGNOSTIC_KEYS);
    const search = pickOrderedFields(instrumentation.search, SNAPSHOT_SEARCH_DIAGNOSTIC_KEYS);
    if (!engine && !search) return undefined;
    return {
        ...(engine ? { engine } : {}),
        ...(search ? { search } : {})
    };
}

/** 
 * Utility for snapshot-based regression testing of engine results.
 */
export const SnapshotUtils = {
    /**
     * Compares a set of statistics against a saved snapshot.
     */
    async assertSnapshot(name: string, stats: any, registry?: any): Promise<void> {
        const snapshotDir = path.resolve(process.cwd(), 'tests', 'snapshots');
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

        if (registry) {
            const humanPath = path.join(snapshotDir, `${name}.human.json`);
            if (!fs.existsSync(humanPath)) {
                throw new Error(`Human snapshot "${name}" not found at ${humanPath}. Run the update-snapshots script first.`);
            }

            const expectedHuman = JSON.parse(fs.readFileSync(humanPath, 'utf8'));
            const actualHuman = HumanizationService.humanize(cleanStats, registry);
            const humanSummary = this.computeStatisticalSummary(actualHuman, expectedHuman);
            if (humanSummary.hasMismatches) {
                const diffPath = path.join(snapshotDir, `${name}.human.actual.json`);
                fs.writeFileSync(diffPath, JSON.stringify(actualHuman, null, 2) + '\n');

                const errorMessage = `Human snapshot mismatch for "${name}".\n${humanSummary.report}\nActual human result saved to ${diffPath}`;
                const error = new Error(errorMessage);
                error.stack = errorMessage;
                throw error;
            }
        }
    },

    /**
     * Performs a memory-efficient statistical analysis of snapshot differences.
     */
    computeStatisticalSummary(actual: any, expected: any): { hasMismatches: boolean; report: string } {
        let hasMismatches = false;
        const sections: string[] = [];

        // 1. Check top-level accuracy
        const aAcc = actual.accuracy || 0;
        const eAcc = expected.accuracy || 0;
        if (Math.abs(aAcc - eAcc) > 1e-12) {
            hasMismatches = true;
            sections.push(`[metadata]: Accuracy mismatch. Expected ${eAcc}, got ${aAcc}`);
        }

        const hasActualClueKnownSpace = actual.clue?.knownSpace !== undefined;
        const hasExpectedClueKnownSpace = expected.clue?.knownSpace !== undefined;
        if (hasActualClueKnownSpace !== hasExpectedClueKnownSpace) {
            hasMismatches = true;
            sections.push(`[metadata]: clue.knownSpace ${hasExpectedClueKnownSpace ? 'missing' : 'unexpected'}`);
        } else if (hasActualClueKnownSpace) {
            const aClue = actual.clue.knownSpace || 0;
            const eClue = expected.clue.knownSpace || 0;
            if (Math.abs(aClue - eClue) > 1e-12) {
                hasMismatches = true;
                sections.push(`[metadata]: clue.knownSpace mismatch. Expected ${eClue}, got ${aClue}`);
            }
            if (actual.clue.idAndRank !== expected.clue.idAndRank) {
                hasMismatches = true;
                sections.push(`[metadata]: clue.idAndRank mismatch. Expected ${expected.clue.idAndRank}, got ${actual.clue.idAndRank}`);
            }
        }

        // 2. Check accounting buckets
        if (actual.accounting && expected.accounting) {
            const report = this.compareAccounting(actual.accounting, expected.accounting);
            if (report.hasMismatches) {
                hasMismatches = true;
                sections.push(report.text);
            }
        }

        const diagnosticsReport = this.compareExactObject(actual.diagnostics, expected.diagnostics, 'diagnostics');
        if (diagnosticsReport.hasMismatches) {
            hasMismatches = true;
            sections.push(diagnosticsReport.text);
        }

        // 3. Check probability categories
        const categories = ['ranks', 'any', 'count', 'combos'];
        for (const item of categories) {
            const report = this.compareProbabilityMap(actual[item] || {}, expected[item] || {}, item);
            if (report.hasMismatches) {
                hasMismatches = true;
                sections.push(report.text);
            }
        }
        const actualShownClues = actual.shownClueDistribution;
        const expectedShownClues = expected.shownClueDistribution;
        if ((actualShownClues === undefined) !== (expectedShownClues === undefined)) {
            hasMismatches = true;
            sections.push(`[metadata]: shownClueDistribution ${expectedShownClues === undefined ? 'unexpected' : 'missing'}`);
        } else if (actualShownClues !== undefined) {
            const report = this.compareProbabilityMap(actualShownClues, expectedShownClues || {}, 'shownClueDistribution');
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
     * Compares two mass accounting objects.
     */
    compareAccounting(actual: any, expected: any) {
        let hasMismatches = false;
        const lines: string[] = ['Category [accounting]:'];

        const buckets = ['resolved', 'clueIncompatible', 'pending', 'sieved', 'overflow', 'capped', 'rounding', 'recoveredRounding', 'recoveredSieved'];
        for (const bucket of buckets) {
            const aVal = actual[bucket] || 0;
            const eVal = expected[bucket] || 0;
            const delta = Math.abs(aVal - eVal);

            // Allow microscopic drift in floating point reporting, but strictly check significant shifts
            if (delta > 1e-15) {
                hasMismatches = true;
                lines.push(`  - ${bucket}: exp ${eVal.toExponential(4)}, got ${aVal.toExponential(4)} (Δ ${delta.toExponential(2)})`);
            }
        }

        // Deep bit-perfect comparison for units if available
        if (actual.units && expected.units) {
            for (const bucket of buckets) {
                const aUnit = actual.units[bucket];
                const eUnit = expected.units[bucket];
                if (aUnit !== eUnit) {
                    hasMismatches = true;
                    lines.push(`  - ${bucket} (units): exp ${eUnit}, got ${aUnit}`);
                }
            }
        } else if (actual.units !== expected.units) { // Fixed structural check
            if (actual.units || expected.units) {
                hasMismatches = true;
                lines.push(`  - Structural: "units" block ${actual.units ? 'added' : 'missing'}`);
            }
        }

        const detailReport = this.compareExactObject(actual.details, expected.details, 'accounting.details');
        if (detailReport.hasMismatches) {
            hasMismatches = true;
            lines.push(detailReport.text);
        }

        return { hasMismatches, text: lines.join('\n') };
    },

    compareExactObject(actual: any, expected: any, name: string) {
        const actualJson = JSON.stringify(actual ?? null);
        const expectedJson = JSON.stringify(expected ?? null);
        if (actualJson === expectedJson) return { hasMismatches: false, text: '' };
        return {
            hasMismatches: true,
            text: `Category [${name}]: exact diagnostic mismatch`
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
            if (aVal === undefined || eVal === undefined) continue;
            const delta = Math.abs(aVal - eVal);

            if (delta > 0) {
                hasMismatches = true;
                sse += delta * delta;
                if (delta > maxDelta) {
                    maxDelta = delta;
                    maxDeltaKey = key;
                }

                // Track top outliers
                const lastOutlier = outliers[outliers.length - 1];
                if (outliers.length < 5 || (lastOutlier !== undefined && delta > lastOutlier.delta)) {
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
    async saveSnapshot(name: string, stats: any, registry?: any): Promise<void> {
        const snapshotDir = path.resolve(process.cwd(), 'tests', 'snapshots');
        const snapshotPath = path.join(snapshotDir, `${name}.json`);

        if (!fs.existsSync(snapshotDir)) {
            fs.mkdirSync(snapshotDir, { recursive: true });
        }

        const cleanStats = this.sanitize(stats);
        fs.writeFileSync(snapshotPath, JSON.stringify(cleanStats, null, 2) + '\n');

        if (registry) {
            const humanPath = path.join(snapshotDir, `${name}.human.json`);
            const humanStats = HumanizationService.humanize(cleanStats, registry);
            fs.writeFileSync(humanPath, JSON.stringify(humanStats, null, 2) + '\n');
            console.log(`Snapshots saved: ${name} (+human)`);
        } else {
            console.log(`Snapshot saved: ${name}`);
        }
    },

    /**
     * Sanitizes stats to ensure deterministic comparison.
     * Truncates probabilities to a reasonable precision to avoid floating point noise.
     */
    sanitize(stats: any): any {
        const sortMap = (obj: any) => {
            if (!obj) return {};
            const keys = Object.keys(obj);
            keys.sort((a, b) => {
                const probA = obj[a];
                const probB = obj[b];
                // Primary: Probability descending
                const delta = probB - probA;
                if (Math.abs(delta) > 1e-15) return delta;
                // Secondary: Key ascending (alphabetical)
                return a.localeCompare(b);
            });

            const res: any = {};
            for (const k of keys) {
                res[k] = roundSnapshotProbability(obj[k]);
            }
            return res;
        };

        const diagnostics = sanitizeDiagnostics(stats.instrumentation);

        return {
            ranks: sortMap(stats.ranks),
            any: sortMap(stats.any),
            count: sortMap(stats.count),
            combos: sortMap(stats.combos),
            ...(stats.shownClueDistribution !== undefined ? { shownClueDistribution: sortMap(stats.shownClueDistribution) } : {}),
            accuracy: roundSnapshotProbability(stats.accuracy),
            accounting: sortAccounting(stats.accounting),
            ...(diagnostics ? { diagnostics } : {}),
            ...(stats.clue?.knownSpace !== undefined
                ? { clue: { idAndRank: stats.clue.idAndRank, knownSpace: roundSnapshotProbability(stats.clue.knownSpace) } }
                : {})
        };
    }
};

/** Assertion timeout scaled for CI runners. */
export const UI_TIMEOUT = process.env['CI'] ? 45000 : 15000;

/**
 * Utilities for Node-based engine tests.
 */
export const EngineTestUtils = {
    /**
     * Compatibility wrapper for older tests; product/tooling code should call engine.getStats directly.
     */
    async getStats(engine: EnchantEngine, request: CheckpointSearchRequest): Promise<EnchantStats> {
        return engine.getStats(request);
    },

    /**
     * Performs a full enchantment simulation and returns human-readable results.
     */
    async getHumanStats(engine: EnchantEngine, item: string, xp: number, material: string, clue: string | null = null, threshold = 0.0001): Promise<any> {
        const stats = await engine.getStats({ item, xp, material, clue, threshold });
        return HumanizationService.humanize(stats, engine.registry);
    }
};
