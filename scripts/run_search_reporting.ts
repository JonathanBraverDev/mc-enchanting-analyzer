/**
 * Shared-search reporting runner.
 *
 * Runs V7-native checkpoint searches across known item/material/xp combinations
 * and writes one JSON report per combination to scripts/search-report-output/.
 *
 * Usage:
 *   npx tsx scripts/run_search_reporting.ts
 *   npx tsx scripts/run_search_reporting.ts --version 1.21.11 --item book --material book --xp 30
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineFactory, EnchantEngine } from '#engine/index.js';
import { getEligibleMaterials } from '#core/registry.js';
import { TEST_DEFAULTS } from '#constants/testing.js';
import { EngineInstrumentation, SearchCheckpoint, SearchResult } from '#types/index.js';
import { ProbUtils } from '#utils/index.js';

const DEFAULT_VERSION = '1.21.11';
const DEFAULT_XP_LEVELS = [10, 15, 20, 25, 30];
const DEFAULT_MASS_TARGETS = [0.1, 0.25, 0.5, 0.75, 0.85, 0.9, 0.95, 0.99, 0.999, 0.9995];
const DEFAULT_THRESHOLD = TEST_DEFAULTS.SNAPSHOT_THRESHOLD;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_OUT_DIR = path.join(__dirname, 'search-report-output');

export interface SearchReportingOptions {
    version: string;
    item?: string | undefined;
    material?: string | undefined;
    xpLevels: number[];
    clue?: string | undefined;
    threshold: number;
    maxIterations?: number | undefined;
    massTargets: number[];
    outputDir: string;
}

export interface SearchCheckpointReport {
    label: string;
    targetClassifiedMass?: number | undefined;
    threshold: number;
    limit: number;
    elapsedMs: number;
    exitReason: string | null;
    iterations: number;
    classifiedMass: number;
    resolvedMass: number;
    pendingMass: number;
    roundingMass: number;
    comboCount: number;
    pendingEntryCount: number;
    largestPendingMass: number;
    lastExpandedMass: number;
    lastExpandedMassUnits: string;
    graphCount: number;
    activeResidueCount: number;
    activeResidueMass: number;
}

export interface SearchRunReport {
    version: string;
    item: string;
    material: string;
    xp: number;
    clue?: string | undefined;
    threshold: number;
    maxIterations: number;
    elapsedMs: number;
    checkpoints: SearchCheckpointReport[];
    final: SearchCheckpointReport;
}

export interface SearchReportingResult {
    generatedAt: string;
    options: SearchReportingOptions;
    reports: SearchRunReport[];
}

export async function generateSearchReporting(options: SearchReportingOptions): Promise<SearchReportingResult> {
    const engine = EngineFactory.createForVersion(options.version);
    const jobs = getJobs(engine, options.item, options.material);
    const reports: SearchRunReport[] = [];

    for (const job of jobs) {
        for (const xp of options.xpLevels) {
            reports.push(await runOne(engine, job.item, job.material, xp, options));
        }
    }

    return {
        generatedAt: new Date().toISOString(),
        options,
        reports
    };
}

export function formatSearchReportingSummary(result: SearchReportingResult): string {
    const lines = [
        `Shared-search reporting: version=${result.options.version}`,
        `Jobs: ${result.reports.length}`,
        `Output: ${result.options.outputDir}`,
        ''
    ];

    for (const report of result.reports) {
        const final = report.final;
        lines.push(`${report.item}/${report.material}/xp=${report.xp}: classified=${formatPercent(final.classifiedMass)} pending=${formatPercent(final.pendingMass)} iterations=${final.iterations} lastNode=${formatPercent(final.lastExpandedMass)} ${report.elapsedMs}ms`);
    }

    return lines.join('\n');
}

async function runOne(
    engine: EnchantEngine,
    item: string,
    material: string,
    xp: number,
    options: SearchReportingOptions
): Promise<SearchRunReport> {
    const checkpoints = buildCheckpoints(item, options);
    const reports: SearchCheckpointReport[] = [];
    const start = performance.now();
    const instrumentation = freshInstrumentation();

    await engine.searchSequentialCheckpoints({
        item,
        material,
        xp,
        clue: options.clue,
        checkpoints,
        instrumentation,
        onCheckpointComplete: (result, checkpointIndex) => {
            const checkpoint = checkpoints[checkpointIndex]!;
            const label = checkpoint.targetClassifiedMass === undefined
                ? 'final'
                : `classified-${checkpoint.targetClassifiedMass}`;
            reports.push(toCheckpointReport(label, result, checkpoint, performance.now() - start));
        }
    });

    const elapsedMs = Math.round(performance.now() - start);
    const final = reports[reports.length - 1];
    if (!final) throw new Error(`No checkpoints completed for ${item}/${material}/xp=${xp}`);

    return {
        version: engine.registry.version,
        item,
        material,
        xp,
        clue: options.clue,
        threshold: options.threshold,
        maxIterations: getLimit(item, options),
        elapsedMs,
        checkpoints: reports,
        final
    };
}

function buildCheckpoints(item: string, options: SearchReportingOptions): SearchCheckpoint[] {
    const limit = getLimit(item, options);
    const checkpoints: SearchCheckpoint[] = options.massTargets.map(targetClassifiedMass => ({
        threshold: 0,
        limit,
        targetClassifiedMass
    }));

    checkpoints.push({
        threshold: options.threshold,
        limit
    });

    return checkpoints;
}

function toCheckpointReport(
    label: string,
    result: SearchResult,
    checkpoint: SearchCheckpoint,
    elapsedMs: number
): SearchCheckpointReport {
    const snapshot = result.snapshot;
    const accounting = snapshot.mass;
    const pending = accounting.pending;
    const classifiedMass = 1 - pending;
    const search = result.instrumentation?.search;

    return {
        label,
        targetClassifiedMass: checkpoint.targetClassifiedMass === undefined ? undefined : Number(checkpoint.targetClassifiedMass),
        threshold: checkpoint.threshold,
        limit: checkpoint.limit,
        elapsedMs: Math.round(elapsedMs),
        exitReason: result.instrumentation?.exitReason ?? null,
        iterations: snapshot.iterations,
        classifiedMass,
        resolvedMass: accounting.resolved,
        pendingMass: pending,
        roundingMass: accounting.rounding,
        comboCount: snapshot.results.size,
        pendingEntryCount: snapshot.pendingCount,
        largestPendingMass: search?.largestPendingMass ?? 0,
        lastExpandedMass: search?.lastExpandedMass ?? 0,
        lastExpandedMassUnits: snapshot.lastExpandedMass.toString(),
        graphCount: snapshot.graphCount,
        activeResidueCount: snapshot.activeResidueCount,
        activeResidueMass: search?.activeResidueMass ?? ProbUtils.toNumber(snapshot.activeResidueMass)
    };
}

function getJobs(engine: EnchantEngine, itemFilter?: string, materialFilter?: string): Array<{ item: string; material: string }> {
    const jobs: Array<{ item: string; material: string }> = [];
    for (const item of Object.keys(engine.registry.itemPool)) {
        if (itemFilter && item !== itemFilter) continue;
        for (const material of getEligibleMaterials(engine.registry, item)) {
            if (materialFilter && material !== materialFilter) continue;
            jobs.push({ item, material });
        }
    }
    return jobs;
}

function getLimit(item: string, options: SearchReportingOptions): number {
    if (options.maxIterations !== undefined) return options.maxIterations;
    return item === 'book'
        ? TEST_DEFAULTS.MODERN_BOOK_SNAPSHOT_ITERATIONS
        : TEST_DEFAULTS.SNAPSHOT_ITERATIONS;
}

function freshInstrumentation(): EngineInstrumentation {
    return {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        totalIterations: 0,
        totalPrunedNodes: 0,
        roundingErrorEvents: 0,
        levelsProcessed: 0,
        levelsFullyResolved: 0,
        fullyResolved: false
    };
}

function parseCliOptions(args: string[]): SearchReportingOptions & { stdoutJson: boolean } {
    const findArg = (key: string): string | null => {
        const index = args.indexOf(key);
        const raw = index >= 0 ? args[index + 1] : undefined;
        return raw && !raw.startsWith('--') ? raw : null;
    };
    const hasFlag = (key: string): boolean => args.includes(key);

    return {
        version: findArg('--version') ?? DEFAULT_VERSION,
        item: findArg('--item') ?? undefined,
        material: findArg('--material') ?? undefined,
        xpLevels: parseNumberList(findArg('--xp'), DEFAULT_XP_LEVELS),
        clue: findArg('--clue') ?? undefined,
        threshold: Number(findArg('--threshold') ?? DEFAULT_THRESHOLD),
        maxIterations: parseOptionalInt(findArg('--limit') ?? findArg('--max-iterations')),
        massTargets: parseNumberList(findArg('--mass-targets'), DEFAULT_MASS_TARGETS),
        outputDir: findArg('--out-dir') ?? DEFAULT_OUT_DIR,
        stdoutJson: hasFlag('--stdout-json') || hasFlag('--json')
    };
}

function parseNumberList(raw: string | null, fallback: number[]): number[] {
    if (raw === null) return [...fallback];
    if (raw.trim() === '') return [];
    return raw.split(',').map(part => Number(part.trim())).filter(value => Number.isFinite(value));
}

function parseOptionalInt(raw: string | null): number | undefined {
    if (raw === null) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function getOutputPath(report: SearchRunReport, outputDir: string): string {
    const cluePart = report.clue ? `_clue_${safeFilePart(report.clue)}` : '';
    const filename = `${safeFilePart(report.version)}_${safeFilePart(report.item)}_${safeFilePart(report.material)}_xp${report.xp}${cluePart}.json`;
    return path.join(outputDir, filename);
}

function safeFilePart(input: string): string {
    return input.replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '');
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(4)}%`;
}

async function main(): Promise<void> {
    const { stdoutJson, ...options } = parseCliOptions(process.argv.slice(2));
    const result = await generateSearchReporting(options);

    if (stdoutJson) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }

    fs.mkdirSync(options.outputDir, { recursive: true });
    for (const report of result.reports) {
        fs.writeFileSync(getOutputPath(report, options.outputDir), `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(formatSearchReportingSummary(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
