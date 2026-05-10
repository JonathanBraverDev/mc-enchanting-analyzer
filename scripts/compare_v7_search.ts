import { EngineFactory } from '#engine/index.js';
import { getFullEnchantName } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { RegistryKernel, SearchRun } from '#lib/index.js';
import { CalculationStats, EngineInstrumentation, PackedCombo } from '#types/index.js';
import { ComboUtils, ProbUtils } from '#utils/index.js';

interface CompareCase {
    readonly label: string;
    readonly version: string;
    readonly item: string;
    readonly material: string;
    readonly xp: number;
    readonly threshold: number;
    readonly maxIterations: number;
}

interface TopCombo {
    readonly hex: string;
    readonly probability: number;
    readonly label: string;
}

const BASE_CASES: CompareCase[] = [
    { label: 'modern sword', version: '1.21.11', item: 'sword', material: 'diamond', xp: 30, threshold: 0.001, maxIterations: 50_000 },
    { label: 'modern mace', version: '1.21', item: 'mace', material: 'mace', xp: 30, threshold: 0.001, maxIterations: 50_000 },
    { label: 'modern book', version: '1.21.11', item: 'book', material: 'book', xp: 30, threshold: 0.0025, maxIterations: 150_000 },
    { label: 'legacy sword', version: '1.8', item: 'sword', material: 'diamond', xp: 30, threshold: 0.001, maxIterations: 50_000 }
];

const DEEP_CASES: CompareCase[] = BASE_CASES.map(testCase => ({
    ...testCase,
    threshold: testCase.item === 'book' ? 0.0005 : 0.00025,
    maxIterations: testCase.item === 'book' ? ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED : 250_000
}));

async function main(): Promise<void> {
    const args = new Set(process.argv.slice(2));
    const matchResolved = args.has('--match-resolved');
    const only = stringArg('--only');
    const cases = (args.has('--deep') ? DEEP_CASES : BASE_CASES)
        .filter(testCase => !only || caseMatches(testCase, only));
    const topN = numberArg('--top', 8);
    const v7MaxIterations = numberArg('--v7-max', ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED);

    console.log(`# V6/V7 search comparison (${args.has('--deep') ? 'deep' : 'baseline'}${matchResolved ? ', match-resolved' : ''})`);
    console.log('');
    console.log('V7 iteration counts are not expected to match V6 because V7 expands shared weighted nodes rather than independent modified-level frontiers.');
    console.log('Snapshots are references, not exact oracles; focus on mass conservation, top-combo overlap, and broad probability distance.');
    console.log('Important: the same numeric threshold is not semantically identical yet; V6 applies it inside each unweighted modified-level search, while this V7 prototype applies it to globally weighted frontier mass.');
    if (matchResolved) console.log('Match-resolved mode runs V7 with threshold=0 until it reaches V6 resolved/classified mass, then compares distributions.');

    for (const testCase of cases) {
        await compareCase(testCase, topN, { matchResolved, v7MaxIterations });
    }
}

async function compareCase(testCase: CompareCase, topN: number, options: { matchResolved: boolean; v7MaxIterations: number }): Promise<void> {
    const engine = EngineFactory.createForVersion(testCase.version);
    engine.resetCaches();

    const v6Timing = { totalMs: 0, searchMs: 0, postProcessingMs: 0 };
    const v6Instrumentation = createInstrumentation();
    const v6Started = performance.now();
    const v6 = await engine.calculate({
        item: testCase.item,
        material: testCase.material,
        xp: testCase.xp,
        threshold: testCase.threshold,
        maxIterations: testCase.maxIterations,
        summaryLimit: ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
        resultsLimit: ENGINE_LIMITS.MAX_RESULTS_UNBOUNDED,
        useCache: false,
        instrumentation: v6Instrumentation,
        timing: v6Timing
    });
    const v6WallMs = performance.now() - v6Started;

    const kernel = new RegistryKernel({ registry: engine.registry, item: testCase.item, material: testCase.material });
    const v7Run = new SearchRun(kernel);
    v7Run.seedXp(testCase.xp);
    const v7Started = performance.now();
    const v7 = options.matchResolved
        ? v7Run.searchToCheckpoint({ threshold: 0n, targetResolvedMass: ProbUtils.toBigInt(v6.accuracy), maxIterations: options.v7MaxIterations })
        : v7Run.searchToCheckpoint({ threshold: testCase.threshold, maxIterations: testCase.maxIterations });
    const v7WallMs = performance.now() - v7Started;

    const v6Combos = combosObjectToMap(v6.combos);
    const v7Combos = bigintMapToNumberMap(v7.results);
    const v6Top = topCombos(v6Combos, engine.registry.indexToEnchant, engine.registry, topN);
    const v7Top = topCombos(v7Combos, engine.registry.indexToEnchant, engine.registry, topN);
    const overlap = topOverlap(v6Top, v7Top);
    const distance = l1Distance(v6Combos, v7Combos);
    const v7TotalMass = massTotal(v7.mass.units!);

    console.log('');
    console.log(`## ${testCase.label} — ${testCase.version} ${testCase.item}/${testCase.material} XP ${testCase.xp}`);
    console.log(`threshold=${testCase.threshold}, maxIterations=${testCase.maxIterations.toLocaleString()}${options.matchResolved ? `, v7TargetResolved=${fmt(v6.accuracy)}, v7MaxIterations=${options.v7MaxIterations.toLocaleString()}` : ''}`);
    console.log('');
    console.log('| metric | V6 | V7 |');
    console.log('|---|---:|---:|');
    console.log(`| wall time ms | ${formatMs(v6WallMs)} | ${formatMs(v7WallMs)} |`);
    console.log(`| iterations | ${v6Instrumentation.totalIterations ?? v6.instrumentation?.totalIterations ?? 'n/a'} | ${v7.iterations} |`);
    console.log(`| result combos | ${Object.keys(v6.combos).length} | ${v7.results.size} |`);
    console.log(`| accuracy/resolved | ${fmt(v6.accuracy)} | ${fmt(v7.mass.resolved)} |`);
    console.log(`| pending | ${fmt(v6.accounting.pending)} | ${fmt(v7.mass.pending)} |`);
    console.log(`| rounding | ${fmt(v6.accounting.rounding)} | ${fmt(v7.mass.rounding)} |`);
    console.log(`| mass total | ${fmt(accountingTotal(v6.accounting))} | ${fmt(ProbUtils.toNumber(v7TotalMass))} |`);
    console.log(`| V7 programs / seeded levels | n/a | ${v7.programCount} / ${v7.seededLevelCount} |`);
    console.log(`| top-${topN} overlap | n/a | ${overlap}/${topN} |`);
    console.log(`| combo L1 distance | n/a | ${fmt(distance)} |`);

    console.log('');
    console.log(`Top ${topN} V6 combos:`);
    printTop(v6Top);
    console.log(`Top ${topN} V7 combos:`);
    printTop(v7Top);
}


function createInstrumentation(): EngineInstrumentation {
    return {
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 },
        frontierCache: { hits: 0, misses: 0 },
        totalIterations: 0,
        totalPrunedNodes: 0,
        roundingErrorEvents: 0,
        levelsProcessed: 0,
        levelsFullyResolved: 0,
        fullyResolved: false
    };
}

function stringArg(name: string): string | null {
    const index = process.argv.indexOf(name);
    const raw = index >= 0 ? process.argv[index + 1] : undefined;
    return raw && !raw.startsWith('--') ? raw : null;
}

function caseMatches(testCase: CompareCase, query: string): boolean {
    const normalized = query.toLowerCase();
    return [testCase.label, testCase.version, testCase.item, testCase.material]
        .some(value => value.toLowerCase().includes(normalized));
}

function numberArg(name: string, fallback: number): number {
    const index = process.argv.indexOf(name);
    const raw = index >= 0 ? process.argv[index + 1] : undefined;
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function combosObjectToMap(combos: CalculationStats['combos']): Map<number, number> {
    const out = new Map<number, number>();
    for (const [hex, probability] of Object.entries(combos)) {
        out.set(Number.parseInt(hex, 16), probability);
    }
    return out;
}

function bigintMapToNumberMap(combos: ReadonlyMap<PackedCombo, bigint>): Map<number, number> {
    const out = new Map<number, number>();
    for (const [combo, mass] of combos) {
        out.set(combo, ProbUtils.toNumber(mass));
    }
    return out;
}

function topCombos(
    combos: Map<number, number>,
    indexToEnchant: number[],
    registry: ReturnType<typeof EngineFactory.createForVersion>['registry'],
    limit: number
): TopCombo[] {
    return [...combos.entries()]
        .sort((a, b) => b[1] - a[1] || b[0] - a[0])
        .slice(0, limit)
        .map(([combo, probability]) => ({
            hex: combo.toString(16),
            probability,
            label: describeCombo(combo as PackedCombo, indexToEnchant, registry)
        }));
}

function describeCombo(
    combo: PackedCombo,
    indexToEnchant: number[],
    registry: ReturnType<typeof EngineFactory.createForVersion>['registry']
): string {
    const enchants = ComboUtils.unpack(combo, indexToEnchant);
    if (enchants.length === 0) return '(empty)';
    return enchants.map(enchant => getFullEnchantName(registry, enchant)).join(' + ');
}

function printTop(combos: TopCombo[]): void {
    for (const [index, combo] of combos.entries()) {
        console.log(`${index + 1}. ${fmt(combo.probability)} — ${combo.label} (${combo.hex})`);
    }
}

function topOverlap(left: TopCombo[], right: TopCombo[]): number {
    const rightHexes = new Set(right.map(combo => combo.hex));
    return left.filter(combo => rightHexes.has(combo.hex)).length;
}

function l1Distance(left: Map<number, number>, right: Map<number, number>): number {
    const keys = new Set([...left.keys(), ...right.keys()]);
    let total = 0;
    for (const key of keys) total += Math.abs((left.get(key) ?? 0) - (right.get(key) ?? 0));
    return total;
}

function accountingTotal(accounting: CalculationStats['accounting']): number {
    return accounting.resolved
        + accounting.clueIncompatible
        + accounting.pending
        + accounting.sieved
        + accounting.overflow
        + accounting.capped
        + accounting.rounding;
}

function massTotal(units: NonNullable<CalculationStats['accounting']['units']>): bigint {
    return BigInt(units.resolved)
        + BigInt(units.clueIncompatible)
        + BigInt(units.pending)
        + BigInt(units.sieved)
        + BigInt(units.overflow)
        + BigInt(units.capped)
        + BigInt(units.rounding);
}

function fmt(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    if (Math.abs(value) >= 0.001) return `${(value * 100).toFixed(4)}%`;
    if (value === 0) return '0';
    return value.toExponential(4);
}

function formatMs(ms: number): string {
    return ms.toFixed(1);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
