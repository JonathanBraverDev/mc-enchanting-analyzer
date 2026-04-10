/**
 * Analyzes matrix-output/ files and prints thinning curves.
 * Shows: at what next.prob value did each mass% checkpoint get reached,
 * and the iteration cost at each checkpoint.
 *
 * Usage: npx tsx scripts/analyze_matrix.ts [--cat book] [--xp 30]
 */
import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'matrix-output');

const args = process.argv.slice(2);
const filterCat = args[args.indexOf('--cat') + 1] ?? null;
const filterXp  = args[args.indexOf('--xp')  + 1] ? parseInt(args[args.indexOf('--xp') + 1]) : null;

interface FileData {
    cat: string; mat: string; xp: number;
    uncertainty: number; elapsedMs: number;
    instrumentation: {
        totalIterations: number;
        exitReason: string | null;
        checkpoints: { mass: number; threshold: number; iterations: number; totalIterations: number }[];
    };
}

function loadAll(): FileData[] {
    return fs.readdirSync(OUT_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')) as FileData)
        .filter(d => (!filterCat || d.cat === filterCat) && (!filterXp || d.xp === filterXp));
}

function formatThreshold(t: number): string {
    if (t === 0) return '0';
    const e = Math.floor(Math.log10(t));
    const m = t / Math.pow(10, e);
    return `${m.toFixed(2)}e${e}`;
}

function summarize(data: FileData[]) {
    // Group by cat
    const byCat = new Map<string, FileData[]>();
    for (const d of data) {
        if (!byCat.has(d.cat)) byCat.set(d.cat, []);
        byCat.get(d.cat)!.push(d);
    }

    for (const [cat, items] of [...byCat.entries()].sort()) {
        // Average across materials, group by xp
        const byXp = new Map<number, FileData[]>();
        for (const d of items) {
            if (!byXp.has(d.xp)) byXp.set(d.xp, []);
            byXp.get(d.xp)!.push(d);
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`CAT: ${cat}`);
        console.log(`${'='.repeat(60)}`);

        for (const xp of [10, 20, 30]) {
            const group = byXp.get(xp);
            if (!group) continue;

            // Average uncertainty and iterations
            const avgUncertainty = group.reduce((s, d) => s + d.uncertainty, 0) / group.length;
            const avgIterations  = group.reduce((s, d) => s + d.instrumentation.totalIterations, 0) / group.length;
            const exitReasons    = [...new Set(group.map(d => d.instrumentation.exitReason))].join('/');

            console.log(`\n  xp=${xp}  avg_uncertainty=${(avgUncertainty * 100).toFixed(4)}%  avg_iters=${Math.round(avgIterations)}  exit=${exitReasons}`);

            // Thinning curve: average threshold at each mass checkpoint across materials
            // Checkpoints are [10%, 25%, 50%, 75%, 80%, 85%, 90%, 95%, 99%, 99.9%]
            // Each file may have different number of checkpoints depending on convergence
            const cpCount = Math.max(...group.map(d => d.instrumentation.checkpoints.length));
            if (cpCount === 0) {
                console.log('    No checkpoints recorded (fully converged before first checkpoint)');
                continue;
            }

            console.log(`    Mass%     threshold(avg)   iters(avg)`);
            for (let i = 0; i < cpCount; i++) {
                const cps = group.map(d => d.instrumentation.checkpoints[i]).filter(Boolean);
                if (cps.length === 0) continue;
                const avgThreshold = cps.reduce((s, c) => s + c.threshold, 0) / cps.length;
                const avgIters     = cps.reduce((s, c) => s + c.iterations, 0) / cps.length;
                const mass         = cps[0].mass; // same target across all
                console.log(`    ${(mass * 100).toFixed(1).padStart(5)}%   ${formatThreshold(avgThreshold).padEnd(16)}  ${Math.round(avgIters)}`);
            }
        }
    }
}

// Also print a summary table: worst-case uncertainty by cat
function worstCaseTable(data: FileData[]) {
    console.log('\n\n' + '='.repeat(60));
    console.log('WORST-CASE UNCERTAINTY BY CAT (xp=30, threshold=0.0001)');
    console.log('='.repeat(60));

    const byCat = new Map<string, number>();
    for (const d of data.filter(d => d.xp === 30)) {
        const prev = byCat.get(d.cat) ?? 0;
        byCat.set(d.cat, Math.max(prev, d.uncertainty));
    }

    const sorted = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cat, u] of sorted) {
        const bar = '█'.repeat(Math.round(u * 10000));
        console.log(`  ${cat.padEnd(15)} ${(u * 100).toFixed(4)}%  ${bar}`);
    }
}

const data = loadAll();
worstCaseTable(data);
summarize(data);
