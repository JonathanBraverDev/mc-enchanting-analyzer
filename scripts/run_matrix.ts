/**
 * Instrumentation matrix runner.
 * Runs getFullStats across all meaningful (cat, mat, xp) combinations
 * at a deep threshold, writing one JSON file per combination to scripts/matrix-output/.
 *
 * Usage: npx tsx scripts/run_matrix.ts
 */
import { EnchantEngine } from '../src/lib/engine/index.js';
import { DATA } from '../src/lib/data/index.js';
import { EngineInstrumentation } from '../src/lib/types/index.js';
import * as fs from 'fs';
import * as path from 'path';

const VERSION = '1.21.11';
const XP_LEVELS = [10, 20, 30];
const THRESHOLD = 0.0001;
const MAX_ITERATIONS = 50000;
const RESULTS_LIMIT = 2000;

const ARMOR_CATS = ['helmet', 'chestplate', 'leggings', 'boots'];
const TOOL_CATS  = ['sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'bow', 'crossbow', 'fishing_rod', 'trident', 'mace', 'spear'];
const ARMOR_MATS = ['leather', 'chain', 'iron', 'diamond', 'gold', 'netherite', 'turtle_shell', 'copper'];
const TOOL_MATS  = ['wood', 'stone', 'iron', 'diamond', 'gold', 'netherite', 'copper'];

const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'matrix-output');
fs.mkdirSync(OUT_DIR, { recursive: true });

function freshInstrumentation(): EngineInstrumentation {
    return {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0, totalPrunedNodes: 0, roundingErrorEvents: 0, checkpointSummary: [], levelsProcessed: 0, levelsFullyResolved: 0, fullyResolved: false,
        checkpoints: []
    };
}

async function runOne(engine: EnchantEngine, cat: string, mat: string, xp: number): Promise<void> {
    const outFile = path.join(OUT_DIR, `${cat}_${mat}_xp${xp}.json`);

    const instr = freshInstrumentation();
    const start = performance.now();
    let stats;
    let error: string | null = null;

    try {
        stats = await engine.getFullStats(cat, xp, mat, {
            instrumentation: instr,
            threshold: THRESHOLD,
            maxIterations: MAX_ITERATIONS,
            resultsLimit: RESULTS_LIMIT,
        });
    } catch (e: any) {
        error = e?.message ?? String(e);
    }

    const elapsed = performance.now() - start;

    const result = {
        version: VERSION,
        cat, mat, xp,
        threshold: THRESHOLD,
        elapsedMs: Math.round(elapsed),
        error,
        uncertainty: stats?.uncertainty ?? null,
        pruned: stats?.pruned ?? null,
        roundingError: stats?.roundingError ?? null,
        comboCount: stats ? Object.keys(stats.combos).length : null,
        instrumentation: {
            poolCache: instr.poolCache,
            distCache: instr.distCache,
            frontierCache: instr.frontierCache,
            totalIterations: instr.totalIterations,
            exitReason: instr.exitReason ?? null,
            checkpoints: instr.checkpoints,
        },
    };

    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    const status = error ? '✗ ERROR' : `✓ uncertainty=${(result.uncertainty! * 100).toFixed(4)}% iters=${instr.totalIterations} ${Math.round(elapsed)}ms`;
    console.log(`  ${cat}/${mat}/xp=${xp}: ${status}`);
}

async function main() {
    console.log(`Matrix run — version: ${VERSION}, threshold: ${THRESHOLD}`);
    console.log(`Output: ${OUT_DIR}\n`);

    // One engine per version — reuse across all combos (benefits pool/dist cache)
    const engine = new EnchantEngine(DATA, VERSION);

    const jobs: Array<{ cat: string; mat: string }> = [];
    for (const cat of ARMOR_CATS) for (const mat of ARMOR_MATS) jobs.push({ cat, mat });
    for (const cat of TOOL_CATS)  for (const mat of TOOL_MATS)  jobs.push({ cat, mat });
    jobs.push({ cat: 'book', mat: 'book' });

    const total = jobs.length * XP_LEVELS.length;
    let done = 0;

    for (const { cat, mat } of jobs) {
        console.log(`${cat}/${mat}`);
        for (const xp of XP_LEVELS) {
            await runOne(engine, cat, mat, xp);
            done++;
        }
    }

    console.log(`\nDone — ${done}/${total} combinations written to ${OUT_DIR}`);
}

main().catch(console.error);
