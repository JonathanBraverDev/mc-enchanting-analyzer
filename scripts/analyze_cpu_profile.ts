import fs from 'node:fs';
import path from 'node:path';

interface CpuProfileCallFrame {
    readonly functionName?: string;
    readonly url?: string;
}

interface CpuProfileNode {
    readonly id: number;
    readonly callFrame: CpuProfileCallFrame;
    readonly children?: readonly number[];
}

interface CpuProfile {
    readonly nodes: readonly CpuProfileNode[];
    readonly samples?: readonly number[];
    readonly timeDeltas?: readonly number[];
}

interface FrameKey {
    readonly functionName: string;
    readonly url: string;
}

interface ProfileSample {
    readonly self: FrameKey;
    readonly stack: readonly FrameKey[];
    readonly microseconds: number;
}

interface PhaseRule {
    readonly name: string;
    readonly matches: (frame: FrameKey) => boolean;
}

interface CliOptions {
    readonly files: readonly string[];
    readonly top: number;
    readonly includeIdle: boolean;
}

const DEFAULT_TOP = 15;

const projectionFunctions = new Set([
    'projectPlexResults',
    'projectPlexCheckpoint',
    'projectPlexPayloadMass',
    'materializePlexPayloadFactors',
    'materializePlexPayloadWithRemovedChoice',
    'materializeBookFactors',
    'materializePlexPayload',
    'visit',
    'pack'
]);

const engineFunctions = new Set([
    'seedXp',
    'step',
    'advance',
    'searchToCheckpoint',
    'advanceUntilCheckpoint',
    'expand',
    'forwardOrResolve',
    'pushPending',
    'popLargestPending',
    'pushOrMerge',
    'setPosition',
    'sinkDown',
    'bubbleUp',
    'moveHeapEntry',
    'buildGroupedEdges',
    'buildSearchExpansion',
    'getOrCreateNodeId',
    'getExpansion',
    'appendPlexPayloadEdge',
    'createCanonicalPlexPayload',
    'insertPackedEnchant',
    'insertWeightedChoice',
    'getPlexPayloadInternNode',
    'getOrCreatePayloadInternNode',
    'canonicalizeWeightedChoice',
    'canonicalizePackedEnchantList',
    'recordResolved',
    'recordResidueDelta',
    'recordResiduePromotion'
]);

const phaseRules: readonly PhaseRule[] = [
    {
        name: 'projection/materialization',
        matches: frame => projectionFunctions.has(frame.functionName)
            || frame.url.includes('PlexProjection')
            || (frame.url.includes('ComboUtils') && (frame.functionName === 'pack' || frame.functionName === '(anonymous)'))
    },
    {
        name: 'engine/search',
        matches: frame => engineFunctions.has(frame.functionName)
            || frame.url.includes('search/plex/PlexGraph.ts')
            || frame.url.includes('search/plex/PlexRunFrontier.ts')
    }
];

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    if (options.files.length === 0) {
        printUsage();
        process.exit(1);
    }

    for (const file of options.files) {
        analyzeFile(file, options);
    }
}

function parseArgs(args: readonly string[]): CliOptions {
    const files: string[] = [];
    let top = DEFAULT_TOP;
    let includeIdle = false;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (arg === '--top') {
            const value = args[++index];
            if (value === undefined) throw new Error('--top requires a number.');
            top = parsePositiveInteger(value, '--top');
        } else if (arg.startsWith('--top=')) {
            top = parsePositiveInteger(arg.slice('--top='.length), '--top');
        } else if (arg === '--include-idle') {
            includeIdle = true;
        } else if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        } else if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            files.push(arg);
        }
    }

    return { files, top, includeIdle };
}

function parsePositiveInteger(value: string, label: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer, got ${value}.`);
    }
    return parsed;
}

function printUsage(): void {
    console.log([
        'Usage: tsx scripts/analyze_cpu_profile.ts [--top N] [--include-idle] <CPU.cpuprofile...>',
        '',
        'Splits Node/V8 CPU profile samples into coarse Plex phases using call-stack ancestry:',
        '- engine/search',
        '- projection/materialization',
        '- runtime/unattributed',
        '- shared/runtime/other',
        '',
        'Example:',
        '  node --cpu-prof --import tsx scratch/plex-book-once.ts',
        '  tsx scripts/analyze_cpu_profile.ts --top 20 CPU.*.cpuprofile'
    ].join('\n'));
}

function analyzeFile(file: string, options: CliOptions): void {
    const profile = readProfile(file);
    const samples = collectSamples(profile);
    const filteredSamples = options.includeIdle
        ? samples
        : samples.filter(sample => sample.self.functionName !== '(idle)');
    const totalMicroseconds = sumNumbers(filteredSamples.map(sample => sample.microseconds));

    const phaseTotals = new Map<string, number>();
    const phaseSelf = new Map<string, Map<string, number>>();
    const totalSelf = new Map<string, number>();

    for (const sample of filteredSamples) {
        const phase = classifySample(sample);
        addToMap(phaseTotals, phase, sample.microseconds);
        addToNestedMap(phaseSelf, phase, formatFrame(sample.self), sample.microseconds);
        addToMap(totalSelf, formatFrame(sample.self), sample.microseconds);
    }

    console.log(`\n=== ${path.basename(file)} ===`);
    console.log(`samples=${filteredSamples.length} totalSelf=${formatMs(totalMicroseconds)}`);

    console.log('\nPHASE TOTALS');
    for (const [phase, microseconds] of sortedEntries(phaseTotals)) {
        console.log(`${formatMs(microseconds).padStart(10)} ${formatPercent(microseconds, totalMicroseconds).padStart(7)}  ${phase}`);
    }

    console.log(`\nTOP ${options.top} OVERALL SELF`);
    printTop(totalSelf, totalMicroseconds, options.top);

    for (const [phase, phaseTotal] of sortedEntries(phaseTotals)) {
        const entries = phaseSelf.get(phase);
        if (!entries) continue;
        console.log(`\nTOP ${options.top} SELF IN ${phase}`);
        printTop(entries, phaseTotal, options.top);
    }
}

function readProfile(file: string): CpuProfile {
    if (!fs.existsSync(file)) throw new Error(`Profile not found: ${file}`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CpuProfile;
}

function collectSamples(profile: CpuProfile): readonly ProfileSample[] {
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    const parents = createParentMap(profile.nodes);
    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    const collected: ProfileSample[] = [];

    for (let index = 0; index < samples.length; index++) {
        const sampleId = samples[index]!;
        const microseconds = deltas[index] ?? 0;
        const stack = stackForSample(sampleId, nodes, parents);
        const self = stack[0];
        if (!self) continue;
        collected.push({ self, stack, microseconds });
    }

    return collected;
}

function createParentMap(nodes: readonly CpuProfileNode[]): Map<number, number> {
    const parents = new Map<number, number>();
    for (const node of nodes) {
        for (const child of node.children ?? []) {
            parents.set(child, node.id);
        }
    }
    return parents;
}

function stackForSample(
    sampleId: number,
    nodes: ReadonlyMap<number, CpuProfileNode>,
    parents: ReadonlyMap<number, number>
): readonly FrameKey[] {
    const stack: FrameKey[] = [];
    const seen = new Set<number>();
    let current: number | undefined = sampleId;

    while (current !== undefined && !seen.has(current)) {
        seen.add(current);
        const node = nodes.get(current);
        if (!node) break;
        stack.push(frameForNode(node));
        current = parents.get(current);
    }

    return stack;
}

function frameForNode(node: CpuProfileNode): FrameKey {
    return {
        functionName: node.callFrame.functionName || '(anonymous)',
        url: shortenUrl(node.callFrame.url || '')
    };
}

function shortenUrl(url: string): string {
    const srcLibIndex = url.indexOf('/src/lib/');
    if (srcLibIndex >= 0) return url.slice(srcLibIndex + '/src/lib/'.length);

    const repoIndex = url.indexOf('/tmp/mcea-conflict-squash/');
    if (repoIndex >= 0) return url.slice(repoIndex + '/tmp/mcea-conflict-squash/'.length);

    if (url.startsWith('file://')) return path.basename(url);
    return url;
}

function classifySample(sample: ProfileSample): string {
    for (const rule of phaseRules) {
        if (sample.stack.some(rule.matches)) return rule.name;
    }

    if (sample.self.functionName === '(garbage collector)' || sample.self.functionName === '(program)' || sample.self.functionName === '(idle)') {
        return 'runtime/unattributed';
    }

    return 'shared/runtime/other';
}

function formatFrame(frame: FrameKey): string {
    return `${frame.functionName} — ${frame.url}`;
}

function addToMap(map: Map<string, number>, key: string, value: number): void {
    map.set(key, (map.get(key) ?? 0) + value);
}

function addToNestedMap(map: Map<string, Map<string, number>>, outerKey: string, innerKey: string, value: number): void {
    let nested = map.get(outerKey);
    if (!nested) {
        nested = new Map<string, number>();
        map.set(outerKey, nested);
    }
    addToMap(nested, innerKey, value);
}

function sortedEntries(map: ReadonlyMap<string, number>): readonly [string, number][] {
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function printTop(entries: ReadonlyMap<string, number>, total: number, limit: number): void {
    let index = 1;
    for (const [label, microseconds] of sortedEntries(entries).slice(0, limit)) {
        console.log(`${String(index).padStart(2)}. ${formatMs(microseconds).padStart(10)} ${formatPercent(microseconds, total).padStart(7)}  ${label}`);
        index++;
    }
}

function sumNumbers(values: readonly number[]): number {
    return values.reduce((sum, value) => sum + value, 0);
}

function formatMs(microseconds: number): string {
    return `${(microseconds / 1000).toFixed(2)}ms`;
}

function formatPercent(part: number, total: number): string {
    if (total === 0) return '0.0%';
    return `${((part / total) * 100).toFixed(1)}%`;
}

main();
