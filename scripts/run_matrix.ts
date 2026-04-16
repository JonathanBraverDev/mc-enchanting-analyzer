/**
 * Instrumentation matrix runner.
 * Runs getFullStats across all meaningful (cat, mat, xp) combinations
 * at a deep threshold, writing one JSON file per combination to scripts/matrix-output/.
 *
 * Usage: npx tsx scripts/run_matrix.ts
 */
import { EnchantEngine, EngineFactory } from '#engine/index.js';
import { DATA } from '../src/lib/data/index.js';
import { EngineInstrumentation } from '#types/index.js';
import * as fs from 'fs';
import * as path from 'path';

import { fileURLToPath } from 'url';

const VERSION = '1.21.11';
const XP_LEVELS = [10, 20, 30];
const THRESHOLD = 0.0001;
const MAX_ITERATIONS = 50000;
const RESULTS_LIMIT = 2000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, 'matrix-output');
fs.mkdirSync(OUT_DIR, { recursive: true });

function getJobs(engine: EnchantEngine): Array<{ cat: string; mat: string }> {
    const registry = engine.registry;
    const categories = Object.keys(registry.mergedItems);
    const versionMaterials = registry.mergedMaterials;
    
    const { ARMOR_CATS, ITEM_SPECIFIC_CATS } = DATA.constants;
    const armorMats = Object.keys(DATA.material_values.armor).filter(m => versionMaterials.has(m as any));
    const toolMats = Object.keys(DATA.material_values.tools).filter(m => versionMaterials.has(m as any));

    const jobs: Array<{ cat: string; mat: string }> = [];

    for (const cat of categories) {
        if (cat === 'book') {
            jobs.push({ cat: 'book', mat: 'book' });
            continue;
        }

        // 1. Item-specific items (bow, mace, etc.) usually have a single material matched to their name
        if (ITEM_SPECIFIC_CATS.includes(cat)) {
            if (versionMaterials.has(cat)) {
                jobs.push({ cat, mat: cat });
            } else if (cat === 'spear') {
                // Special case: spear is item-specific but uses tool materials in 1.21.11
                for (const mat of toolMats) jobs.push({ cat, mat });
            }
            continue;
        }

        // 2. Armor categories
        if (ARMOR_CATS.includes(cat)) {
            for (const mat of armorMats) {
                if (mat === 'turtle_shell' && cat !== 'helmet') continue;
                jobs.push({ cat, mat });
            }
            continue;
        }

        // 3. General tool categories (sword, pickaxe, etc.)
        for (const mat of toolMats) {
            jobs.push({ cat, mat });
        }
    }

    return jobs;
}

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
        stats = await engine.calculate(cat, xp, mat, {
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
        uncertainty: stats?.accounting.pending ?? null,
        pruned: stats?.accounting.sieved ?? null,
        roundingError: stats?.accounting.rounding ?? null,
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
    const engine = EngineFactory.create(DATA, VERSION);

    const jobs = getJobs(engine);

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
