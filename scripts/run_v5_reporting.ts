/**
 * V5 reporting runner.
 * Runs V5 checkpoint searches across meaningful item/material/xp combinations and
 * writes one JSON file per combination to scripts/v5-report-output/.
 *
 * Usage: npx tsx scripts/run_v5_reporting.ts
 */
import { EnchantEngine, EngineFactory } from '#engine/index.js';
import { getEligibleMaterials } from '#core/registry.js';
import { SearchResult, EngineInstrumentation, ExploredMassSample } from '#types/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_VERSION = '1.21.11';
const DEFAULT_XP_LEVELS = [10, 20, 30];
const RESULTS_LIMIT = 2000;
const EXPLORED_MASS_TARGETS = [0.1, 0.25, 0.5, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99, 0.999];
const THRESHOLD = 0.0001;
const MAX_ITERATIONS = 50_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, 'v5-report-output');
fs.mkdirSync(OUT_DIR, { recursive: true });

const args = process.argv.slice(2);
const findArg = (key: string) => {
    const idx = args.indexOf(key);
    const next = idx !== -1 ? args[idx + 1] : undefined;
    return next && !next.startsWith('--') ? next : null;
};

function getJobs(engine: EnchantEngine): Array<{ item: string; material: string }> {
    const registry = engine.registry;
    const items = Object.keys(registry.itemPool);
    const jobs: Array<{ item: string; material: string }> = [];

    for (const item of items) {
        for (const material of getEligibleMaterials(registry, item)) jobs.push({ item, material });
    }

    return jobs;
}

function freshInstrumentation(): EngineInstrumentation {
    return {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0,
        totalPrunedNodes: 0,
        roundingErrorEvents: 0,
        levelsProcessed: 0,
        levelsFullyResolved: 0,
        fullyResolved: false,
        exploredMassTargets: EXPLORED_MASS_TARGETS,
        exploredMassSamples: []
    };
}

function toReport(result: SearchResult, elapsedMs: number) {
    const accounting = result.tracker.mass.toPublic();
    const instrumentation = result.instrumentation;

    return {
        threshold: result.threshold,
        elapsedMs: Math.round(elapsedMs),
        uncertainty: accounting.pending,
        pruned: accounting.sieved,
        roundingError: accounting.rounding,
        resolved: accounting.resolved,
        comboCount: result.combos.size,
        instrumentation: {
            poolCache: instrumentation?.poolCache ?? { hits: 0, misses: 0 },
            distCache: instrumentation?.distCache ?? { hits: 0, misses: 0 },
            frontierCache: instrumentation?.frontierCache ?? { hits: 0, misses: 0 },
            totalIterations: instrumentation?.totalIterations ?? 0,
            totalPrunedNodes: instrumentation?.totalPrunedNodes ?? 0,
            roundingErrorEvents: instrumentation?.roundingErrorEvents ?? 0,
            levelsProcessed: instrumentation?.levelsProcessed ?? 0,
            levelsFullyResolved: instrumentation?.levelsFullyResolved ?? 0,
            fullyResolved: instrumentation?.fullyResolved ?? false,
            exitReason: instrumentation?.exitReason ?? null
        }
    };
}

function summarizeSamples(samples: ExploredMassSample[]): ExploredMassSample[] {
    const byTarget = new Map<number, ExploredMassSample[]>();
    for (const target of EXPLORED_MASS_TARGETS) byTarget.set(target, []);

    for (const sample of samples) {
        byTarget.get(sample.targetMass)?.push(sample);
    }

    const summarized: ExploredMassSample[] = [];
    for (const target of EXPLORED_MASS_TARGETS) {
        const samplesForTarget = byTarget.get(target) ?? [];
        if (samplesForTarget.length === 0) continue;

        const bottleneck = samplesForTarget.reduce(
            (worst, sample) => sample.frontierProbability < worst.frontierProbability ? sample : worst,
            samplesForTarget[0]!
        );

        summarized.push({
            modLevel: bottleneck.modLevel,
            targetMass: target,
            exploredMass: samplesForTarget.reduce((sum, sample) => sum + sample.exploredMass, 0) / samplesForTarget.length,
            frontierProbability: bottleneck.frontierProbability,
            iterations: Math.max(...samplesForTarget.map(sample => sample.iterations)),
            totalIterations: Math.max(...samplesForTarget.map(sample => sample.totalIterations))
        });
    }

    return summarized;
}

async function runOne(engine: EnchantEngine, item: string, material: string, xp: number): Promise<void> {
    const outFile = path.join(OUT_DIR, `${item}_${material}_xp${xp}.json`);
    const instrumentation = freshInstrumentation();
    let report: ReturnType<typeof toReport> | null = null;
    const start = performance.now();
    let error: string | null = null;

    try {
        const result = await engine.searchToCheckpoint({
                item,
                xp,
                material,
                threshold: THRESHOLD,
                maxIterations: MAX_ITERATIONS,
                instrumentation,
                resultsLimit: RESULTS_LIMIT
            });
        report = toReport(result, performance.now() - start);
    } catch (e: any) {
        error = e?.message ?? String(e);
    }

    const samples = summarizeSamples(instrumentation.exploredMassSamples ?? []);
    const result = {
        version: engine.registry.version,
        item,
        material,
        xp,
        exploredMassTargets: EXPLORED_MASS_TARGETS,
        elapsedMs: Math.round(performance.now() - start),
        error,
        uncertainty: report?.uncertainty ?? null,
        pruned: report?.pruned ?? null,
        roundingError: report?.roundingError ?? null,
        comboCount: report?.comboCount ?? null,
        report,
        exploredMassSamples: samples
    };

    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

    const status = error
        ? 'ERROR'
        : `uncertainty=${((report?.uncertainty ?? 0) * 100).toFixed(4)}% iters=${report?.instrumentation.totalIterations ?? 0} samples=${samples.length} ${result.elapsedMs}ms`;
    console.log(`  ${item}/${material}/xp=${xp}: ${status}`);
}

async function main() {
    const version = findArg('--version') ?? DEFAULT_VERSION;
    const filterItem = findArg('--item');
    const filterMaterial = findArg('--material');
    const xpArg = findArg('--xp');
    const xpLevels = xpArg ? [parseInt(xpArg)] : DEFAULT_XP_LEVELS;

    console.log(`V5 reporting run: version=${version}`);
    console.log(`Output: ${OUT_DIR}\n`);

    const engine = EngineFactory.createForVersion(version);
    const jobs = getJobs(engine)
        .filter(job => !filterItem || job.item === filterItem)
        .filter(job => !filterMaterial || job.material === filterMaterial);
    const total = jobs.length * xpLevels.length;
    let done = 0;

    for (const { item, material } of jobs) {
        console.log(`${item}/${material}`);
        for (const xp of xpLevels) {
            await runOne(engine, item, material, xp);
            done++;
        }
    }

    console.log(`\nDone: ${done}/${total} combinations written to ${OUT_DIR}`);
}

main().catch(console.error);
