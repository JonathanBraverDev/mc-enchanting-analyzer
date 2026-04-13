/**
 * Runs only the combinations missing from the previous matrix run:
 * - copper for all tool/armor categories
 * - spear for all tool materials (including copper)
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
const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'matrix-output');

function freshInstrumentation(): EngineInstrumentation {
    return { poolCache: { hits: 0, misses: 0 }, distCache: { hits: 0, misses: 0 }, frontierCache: { hits: 0, misses: 0 }, totalIterations: 0, checkpoints: [] };
}

async function runOne(engine: EnchantEngine, cat: string, mat: string, xp: number): Promise<void> {
    const outFile = path.join(OUT_DIR, `${cat}_${mat}_xp${xp}.json`);
    const instr = freshInstrumentation();
    const start = performance.now();
    let stats: any; let error: string | null = null;
    try {
        stats = await engine.getFullStats(cat, xp, mat, { instrumentation: instr, threshold: THRESHOLD, maxIterations: MAX_ITERATIONS, resultsLimit: RESULTS_LIMIT });
    } catch (e: any) { error = e?.message ?? String(e); }
    const elapsed = performance.now() - start;
    const result = { version: VERSION, cat, mat, xp, threshold: THRESHOLD, elapsedMs: Math.round(elapsed), error, uncertainty: stats?.uncertainty ?? null, pruned: stats?.pruned ?? null, roundingError: stats?.roundingError ?? null, comboCount: stats ? Object.keys(stats.combos).length : null, instrumentation: { poolCache: instr.poolCache, distCache: instr.distCache, frontierCache: instr.frontierCache, totalIterations: instr.totalIterations, exitReason: instr.exitReason ?? null, checkpoints: instr.checkpoints } };
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    const status = error ? `✗ ${error}` : `✓ uncertainty=${(result.uncertainty! * 100).toFixed(4)}% iters=${instr.totalIterations} ${Math.round(elapsed)}ms`;
    console.log(`  ${cat}/${mat}/xp=${xp}: ${status}`);
}

async function main() {
    const engine = new EnchantEngine(DATA, VERSION);
    const ARMOR_CATS = ['helmet', 'chestplate', 'leggings', 'boots'];
    const TOOL_CATS  = ['sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'bow', 'crossbow', 'fishing_rod', 'trident', 'mace', 'spear'];

    const jobs: Array<{cat: string; mat: string}> = [];
    // copper for all tool cats
    for (const cat of TOOL_CATS) jobs.push({ cat, mat: 'copper' });
    // copper was already in armor matrix, but add spear for all tool mats
    const TOOL_MATS = ['wood', 'stone', 'iron', 'diamond', 'gold', 'netherite', 'copper'];
    for (const mat of TOOL_MATS) if (mat !== 'copper') jobs.push({ cat: 'spear', mat }); // copper already added above

    console.log(`Running ${jobs.length * XP_LEVELS.length} missing combinations...`);
    for (const { cat, mat } of jobs) {
        console.log(`${cat}/${mat}`);
        for (const xp of XP_LEVELS) await runOne(engine, cat, mat, xp);
    }
    console.log('Done.');
}

main().catch(console.error);
