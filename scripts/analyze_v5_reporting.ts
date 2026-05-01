/**
 * Analyzes scripts/v5-report-output/ files produced by run_v5_reporting.ts.
 *
 * Usage: npx tsx scripts/analyze_v5_reporting.ts [--cat book] [--xp 30]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, 'v5-report-output');

const args = process.argv.slice(2);
const findArg = (key: string) => {
    const idx = args.indexOf(key);
    const next = idx !== -1 ? args[idx + 1] : undefined;
    return next && !next.startsWith('--') ? next : null;
};

const filterCat = findArg('--cat');
const xpArg = findArg('--xp');
const filterXp = xpArg ? parseInt(xpArg) : null;

interface ReportData {
    threshold: number;
    elapsedMs: number;
    uncertainty: number;
    pruned: number;
    roundingError: number;
    resolved: number;
    comboCount: number;
    instrumentation: {
        totalIterations: number;
        exitReason: string | null;
    };
}

interface ExploredMassSampleData {
    modLevel: number;
    targetMass: number;
    exploredMass: number;
    frontierProbability: number;
    iterations: number;
    totalIterations: number;
}

interface FileData {
    cat: string;
    mat: string;
    xp: number;
    uncertainty: number | null;
    elapsedMs: number;
    error: string | null;
    report: ReportData | null;
    exploredMassSamples: ExploredMassSampleData[];
}

function loadAll(): FileData[] {
    if (!fs.existsSync(OUT_DIR)) {
        throw new Error(`No V5 report output found at ${OUT_DIR}. Run scripts/run_v5_reporting.ts first.`);
    }

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
    const byCat = new Map<string, FileData[]>();
    for (const d of data) {
        if (!byCat.has(d.cat)) byCat.set(d.cat, []);
        byCat.get(d.cat)!.push(d);
    }

    for (const [cat, items] of [...byCat.entries()].sort()) {
        const byXp = new Map<number, FileData[]>();
        for (const d of items) {
            if (!byXp.has(d.xp)) byXp.set(d.xp, []);
            byXp.get(d.xp)!.push(d);
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`CAT: ${cat}`);
        console.log(`${'='.repeat(60)}`);

        const xpLevels = [...new Set(items.map(d => d.xp))].sort((a, b) => a - b);
        for (const xp of xpLevels) {
            const group = byXp.get(xp);
            if (!group) continue;

            const finalReports = group.map(d => d.report).filter((r): r is ReportData => r !== null);
            const avgUncertainty = finalReports.reduce((s, r) => s + r.uncertainty, 0) / finalReports.length;
            const avgIterations = finalReports.reduce((s, r) => s + r.instrumentation.totalIterations, 0) / finalReports.length;
            const exitReasons = [...new Set(finalReports.map(r => r.instrumentation.exitReason))].join('/');

            console.log(`\n  xp=${xp}  avg_uncertainty=${(avgUncertainty * 100).toFixed(4)}%  avg_iters=${Math.round(avgIterations)}  exit=${exitReasons}`);
            console.log(`    Target    frontier(avg)    explored(avg)      iters(avg)`);

            const targets = [...new Set(group.flatMap(d => d.exploredMassSamples.map(sample => sample.targetMass)))].sort((a, b) => a - b);
            for (const target of targets) {
                const samples = group.flatMap(d => d.exploredMassSamples.filter(sample => sample.targetMass === target));
                if (samples.length === 0) continue;
                const avgFrontier = samples.reduce((s, sample) => s + sample.frontierProbability, 0) / samples.length;
                const avgExplored = samples.reduce((s, sample) => s + sample.exploredMass, 0) / samples.length;
                const avgIterations = samples.reduce((s, sample) => s + sample.totalIterations, 0) / samples.length;
                const targetLabel = `${(target * 100).toFixed(target >= 0.999 ? 1 : 0)}%`;
                console.log(`    ${targetLabel.padEnd(8)}  ${formatThreshold(avgFrontier).padEnd(16)} ${(`${(avgExplored * 100).toFixed(4)}%`).padEnd(17)} ${Math.round(avgIterations)}`);
            }
        }
    }
}

function worstCaseTable(data: FileData[]) {
    console.log('\n\n' + '='.repeat(60));
    console.log('WORST-CASE UNCERTAINTY BY CAT (xp=30)');
    console.log('='.repeat(60));

    const byCat = new Map<string, number>();
    for (const d of data.filter(d => d.xp === 30 && d.uncertainty !== null)) {
        const prev = byCat.get(d.cat) ?? 0;
        byCat.set(d.cat, Math.max(prev, d.uncertainty!));
    }

    const sorted = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cat, uncertainty] of sorted) {
        const bar = '#'.repeat(Math.round(uncertainty * 10000));
        console.log(`  ${cat.padEnd(15)} ${(uncertainty * 100).toFixed(4)}%  ${bar}`);
    }
}

const data = loadAll();
worstCaseTable(data);
summarize(data);
