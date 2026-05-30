import { RegistryFactory } from '#core/factory.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { RegistryKernel } from '#lib/search/index.js';
import type { LevelDistribution, RegistryState } from '#types/index.js';

type SignatureMode = 'child' | 'exact' | 'family';
type OutputMode = 'rows' | 'blocks' | 'weighted-blocks' | 'summary' | 'all';

interface CliOptions {
    readonly version: string;
    readonly xp: number;
    readonly maxLevel: number;
    readonly maxDepth: number;
    readonly outputMode: OutputMode;
    readonly allMaterials: boolean;
    readonly item: string | undefined;
    readonly material: string | undefined;
}

interface ProbeCase {
    readonly item: string;
    readonly material: string;
}

interface LevelMass {
    readonly level: number;
    readonly mass: bigint;
}

interface RowShapeStats {
    readonly probeCase: ProbeCase;
    readonly levels: readonly number[];
    readonly idealCounts: readonly number[];
    readonly exactCounts: readonly number[];
    readonly familyCounts: readonly number[];
    readonly familyIsIdeal: boolean;
}

interface BlockStats {
    readonly size: number;
    readonly same: number;
    readonly total: number;
}

const DEFAULT_OPTIONS: CliOptions = {
    version: '1.21.11',
    xp: 30,
    maxLevel: 64,
    maxDepth: 5,
    outputMode: 'all',
    allMaterials: false,
    item: undefined,
    material: undefined
};

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const registry = RegistryFactory.build(options.version);
    const distributionService = new ModifiedLevelDistributionService();
    const cases = resolveCases(registry, options);
    const rowStats = cases.map(probeCase => buildRowShapeStats(
        registry,
        distributionService,
        probeCase,
        options.xp,
        options.maxDepth
    ));

    console.log([
        `Rank merge shape probe: version=${options.version}`,
        `xp=${options.xp}`,
        `cases=${cases.length}`,
        `maxLevel=${options.maxLevel}`,
        `maxDepth=${options.maxDepth}`
    ].join(' '));

    if (options.outputMode === 'all' || options.outputMode === 'summary') {
        printSummary(rowStats);
    }
    if (options.outputMode === 'all' || options.outputMode === 'rows') {
        printRowShapeTable(rowStats);
    }
    if (options.outputMode === 'all' || options.outputMode === 'blocks') {
        printAlignedBlockTable(registry, cases, options.maxLevel, options.maxDepth);
    }
    if (options.outputMode === 'all' || options.outputMode === 'weighted-blocks') {
        printWeightedBlockTable(registry, distributionService, cases, options.xp, options.maxDepth);
    }
}

function parseArgs(args: readonly string[]): CliOptions {
    let options = DEFAULT_OPTIONS;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        const next = () => {
            const value = args[++index];
            if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
            return value;
        };

        switch (arg) {
            case '--version':
                options = { ...options, version: next() };
                break;
            case '--xp':
                options = { ...options, xp: parsePositiveInteger(next(), arg) };
                break;
            case '--max-level':
                options = { ...options, maxLevel: parsePositiveInteger(next(), arg) };
                break;
            case '--max-depth':
                options = { ...options, maxDepth: parsePositiveInteger(next(), arg) };
                break;
            case '--mode':
                options = { ...options, outputMode: parseOutputMode(next()) };
                break;
            case '--all-materials':
                options = { ...options, allMaterials: true };
                break;
            case '--item':
                options = { ...options, item: next() };
                break;
            case '--material':
                options = { ...options, material: next() };
                break;
            case '--help':
            case '-h':
                printUsage();
                process.exit(0);
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }

    return options;
}

function printUsage(): void {
    console.log([
        'Usage: node --import tsx scripts/probe_rank_merge_shape.ts [options]',
        '',
        'Investigates whether rankless pool families collapse into the ideal level-halving tree shape.',
        '',
        'Modes:',
        '  rows             XP-weighted root levels counted by child/exact/family identity per depth',
        '  blocks           Aligned power-of-two level blocks that share one exact/family signature',
        '  weighted-blocks  XP distribution mass inside aligned same-signature blocks',
        '  summary          Count cases where family rows match ideal child rows',
        '  all              Print all tables (default)',
        '',
        'Options:',
        '  --version VERSION   Default: 1.21.11',
        '  --xp LEVEL          Default: 30',
        '  --item ITEM         Restrict to one item',
        '  --material MATERIAL Restrict to one material; defaults to representative material for item',
        '  --all-materials     Probe every supported item/material pair',
        '  --max-level LEVEL   Highest modified level for block lattice stats. Default: 64',
        '  --max-depth DEPTH   Highest division/block power. Default: 5, meaning 2..32'
    ].join('\n'));
}

function parsePositiveInteger(value: string, label: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer, got ${value}.`);
    return parsed;
}

function parseOutputMode(value: string): OutputMode {
    switch (value) {
        case 'rows':
        case 'blocks':
        case 'weighted-blocks':
        case 'summary':
        case 'all':
            return value;
        default:
            throw new Error(`--mode must be rows, blocks, weighted-blocks, summary, or all; got ${value}.`);
    }
}

function resolveCases(registry: RegistryState, options: CliOptions): ProbeCase[] {
    if (options.item !== undefined) {
        const materials = registry.itemMaterials[options.item];
        if (materials === undefined) throw new Error(`Unknown item: ${options.item}.`);

        const material = options.material ?? chooseRepresentativeMaterial(materials);
        if (!materials.includes(material)) {
            throw new Error(`Item ${options.item} does not support material ${material}.`);
        }

        return [{ item: options.item, material }];
    }

    const cases: ProbeCase[] = [];
    for (const [item, materials] of Object.entries(registry.itemMaterials)) {
        if (options.allMaterials) {
            for (const material of materials) cases.push({ item, material });
        } else {
            cases.push({ item, material: chooseRepresentativeMaterial(materials) });
        }
    }
    return cases;
}

function chooseRepresentativeMaterial(materials: readonly string[]): string {
    const diamond = materials.find(material => material === 'diamond');
    if (diamond !== undefined) return diamond;

    const first = materials[0];
    if (first === undefined) throw new Error('Cannot choose a representative material from an empty material list.');
    return first;
}

function buildRowShapeStats(
    registry: RegistryState,
    distributionService: ModifiedLevelDistributionService,
    probeCase: ProbeCase,
    xp: number,
    maxDepth: number
): RowShapeStats {
    const kernel = new RegistryKernel({ registry, item: probeCase.item, material: probeCase.material });
    const distribution = distributionService.getModifiedLevelDist(registry, xp, kernel.enchantability);
    const levels = getDistributionLevels(distribution);
    const idealCounts = countRowsByMode(kernel, levels, 'child', maxDepth);
    const exactCounts = countRowsByMode(kernel, levels, 'exact', maxDepth);
    const familyCounts = countRowsByMode(kernel, levels, 'family', maxDepth);

    return {
        probeCase,
        levels,
        idealCounts,
        exactCounts,
        familyCounts,
        familyIsIdeal: sequencesEqual(idealCounts, familyCounts)
    };
}

function countRowsByMode(
    kernel: RegistryKernel,
    levels: readonly number[],
    mode: SignatureMode,
    maxDepth: number
): number[] {
    const counts: number[] = [];
    for (let depth = 0; depth <= maxDepth; depth++) {
        const divisor = 2 ** depth;
        const rows = new Set<string>();
        for (const level of levels) {
            rows.add(`${Math.floor(level / divisor)}|${getSignature(kernel, level, mode)}`);
        }
        counts.push(rows.size);
    }
    return counts;
}

function printSummary(rowStats: readonly RowShapeStats[]): void {
    const idealCaseCount = rowStats.filter(stats => stats.familyIsIdeal).length;
    console.log(`Family rows match ideal child rows: ${idealCaseCount}/${rowStats.length}`);

    const byItem = new Map<string, { total: number; ideal: number }>();
    for (const stats of rowStats) {
        const itemStats = byItem.get(stats.probeCase.item) ?? { total: 0, ideal: 0 };
        itemStats.total++;
        if (stats.familyIsIdeal) itemStats.ideal++;
        byItem.set(stats.probeCase.item, itemStats);
    }

    console.table([...byItem.entries()].map(([item, itemStats]) => ({
        item,
        idealFamilyRows: `${itemStats.ideal}/${itemStats.total}`
    })));

    const misses = rowStats.filter(stats => !stats.familyIsIdeal);
    if (misses.length === 0) return;

    console.log('Non-ideal family row cases:');
    console.table(misses.map(stats => ({
        case: caseName(stats.probeCase),
        ideal: formatSequence(stats.idealCounts),
        family: formatSequence(stats.familyCounts)
    })));
}

function printRowShapeTable(rowStats: readonly RowShapeStats[]): void {
    console.log('XP root row shape:');
    console.table(rowStats.map(stats => ({
        case: caseName(stats.probeCase),
        levels: formatLevelRange(stats.levels),
        ideal: formatSequence(stats.idealCounts),
        exact: formatSequence(stats.exactCounts),
        family: formatSequence(stats.familyCounts),
        familyIdeal: stats.familyIsIdeal ? 'yes' : 'no'
    })));
}

function printAlignedBlockTable(
    registry: RegistryState,
    cases: readonly ProbeCase[],
    maxLevel: number,
    maxDepth: number
): void {
    console.log(`Aligned same-signature blocks over levels 1..${maxLevel}:`);
    console.table(cases.map(probeCase => {
        const kernel = new RegistryKernel({ registry, item: probeCase.item, material: probeCase.material });
        const familyBlocks = collectAlignedBlockStats(kernel, 'family', maxLevel, maxDepth);
        const exactBlocks = collectAlignedBlockStats(kernel, 'exact', maxLevel, maxDepth);
        const row: Record<string, string> = { case: caseName(probeCase) };
        addBlockColumns(row, familyBlocks, 'family');
        addBlockColumns(row, exactBlocks, 'exact');
        return row;
    }));
}

function printWeightedBlockTable(
    registry: RegistryState,
    distributionService: ModifiedLevelDistributionService,
    cases: readonly ProbeCase[],
    xp: number,
    maxDepth: number
): void {
    console.log(`XP ${xp} root mass inside aligned same-signature blocks:`);
    console.table(cases.map(probeCase => {
        const kernel = new RegistryKernel({ registry, item: probeCase.item, material: probeCase.material });
        const distribution = distributionService.getModifiedLevelDist(registry, xp, kernel.enchantability);
        const entries = getDistributionEntries(distribution);
        const totalMass = entries.reduce((total, entry) => total + entry.mass, 0n);
        const row: Record<string, string> = {
            case: caseName(probeCase),
            range: formatLevelRange(entries.map(entry => entry.level))
        };

        for (let depth = 1; depth <= maxDepth; depth++) {
            const size = 2 ** depth;
            row[`family${size}`] = percentBig(
                countMassInsideSameAlignedBlocks(kernel, entries, 'family', size),
                totalMass
            );
            row[`exact${size}`] = percentBig(
                countMassInsideSameAlignedBlocks(kernel, entries, 'exact', size),
                totalMass
            );
        }
        return row;
    }));
}

function collectAlignedBlockStats(
    kernel: RegistryKernel,
    mode: SignatureMode,
    maxLevel: number,
    maxDepth: number
): BlockStats[] {
    const stats: BlockStats[] = [];
    for (let depth = 1; depth <= maxDepth; depth++) {
        const size = 2 ** depth;
        let total = 0;
        let same = 0;

        for (let start = size; start + size - 1 <= maxLevel; start += size) {
            total++;
            if (isSameSignatureBlock(kernel, mode, start, size)) same++;
        }

        stats.push({ size, same, total });
    }
    return stats;
}

function countMassInsideSameAlignedBlocks(
    kernel: RegistryKernel,
    entries: readonly LevelMass[],
    mode: SignatureMode,
    size: number
): bigint {
    let mass = 0n;
    for (const entry of entries) {
        const start = Math.floor(entry.level / size) * size;
        if (start < size) continue;
        if (isSameSignatureBlock(kernel, mode, start, size)) mass += entry.mass;
    }
    return mass;
}

function isSameSignatureBlock(
    kernel: RegistryKernel,
    mode: SignatureMode,
    start: number,
    size: number
): boolean {
    const first = getSignature(kernel, start, mode);
    for (let level = start + 1; level < start + size; level++) {
        if (getSignature(kernel, level, mode) !== first) return false;
    }
    return true;
}

function addBlockColumns(
    row: Record<string, string>,
    stats: readonly BlockStats[],
    prefix: string
): void {
    for (const block of stats) {
        row[`${prefix}${block.size}`] = `${block.same}/${block.total} ${percent(block.same, block.total)}`;
    }
}

function getSignature(kernel: RegistryKernel, level: number, mode: SignatureMode): string {
    switch (mode) {
        case 'child':
            return 'child';
        case 'exact':
            return kernel.getPool(level).signature;
        case 'family':
            return kernel.getPool(level).familySignature;
    }
}

function getDistributionLevels(distribution: LevelDistribution): number[] {
    return Object.keys(distribution)
        .map(Number)
        .sort((left, right) => left - right);
}

function getDistributionEntries(distribution: LevelDistribution): LevelMass[] {
    return Object.entries(distribution)
        .map(([level, mass]) => ({ level: Number(level), mass }))
        .filter(entry => entry.mass > 0n)
        .sort((left, right) => left.level - right.level);
}

function sequencesEqual(left: readonly number[], right: readonly number[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatSequence(values: readonly number[]): string {
    return values.join(' -> ');
}

function formatLevelRange(levels: readonly number[]): string {
    const first = levels[0];
    const last = levels[levels.length - 1];
    if (first === undefined || last === undefined) return '0';
    return `${levels.length} [${first}-${last}]`;
}

function caseName(probeCase: ProbeCase): string {
    return `${probeCase.item}/${probeCase.material}`;
}

function percent(numerator: number, denominator: number): string {
    if (denominator === 0) return 'n/a';
    return `${((100 * numerator) / denominator).toFixed(1)}%`;
}

function percentBig(numerator: bigint, denominator: bigint): string {
    if (denominator === 0n) return 'n/a';
    const basisPoints = (numerator * 10000n) / denominator;
    return `${(Number(basisPoints) / 100).toFixed(2)}%`;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
