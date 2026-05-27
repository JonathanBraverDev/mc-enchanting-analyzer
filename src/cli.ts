#!/usr/bin/env node
import { EnchantingAnalyzer } from '#lib/index.js';
import type { AnalyzerRequest, AnalyzerSearchControls, AnalyzerSearchPreset, ResultSortMode } from '#lib/index.js';

type OutputFormat = 'text' | 'json' | 'raw-json';

interface CliOptions {
    minecraftVersion?: string;
    item?: string;
    material?: string;
    xp?: number;
    clue?: string | null;
    searchPreset?: AnalyzerSearchPreset;
    searchControls: AnalyzerSearchControls;
    summaryLimit?: number;
    uncappedResults?: boolean;
    format: OutputFormat;
    sortMode: ResultSortMode;
}

const HELP = `Minecraft Enchanting Analyzer CLI

Usage:
  mcenchant 1.21 pickaxe diamond 30
  mcenchant 1.21 sword diamond 30 -s deep -f json
  mcenchant 1.21 sword diamond 1 --search exhaustive --raw
  mcenchant --version 1.21 --item pickaxe --material diamond --xp 30

Required:
  <version> <item> <material> <xp>
  -v, --version <version>       Minecraft version, such as 1.21, 1.14.2, or 1.7.1
  -i, --item <item>             Item key, such as sword, book, or pickaxe
  -m, --material <material>     Material key, such as diamond, book, or bow
  -x, --xp <level>              Player XP level

Search:
  -s, --search <mode>           coarse, standard, deep, ultra, or exhaustive
      --threshold <value>       Stop below this pending probability
      --target-mass <value>     Stop once classified mass reaches this value
      --max-iterations <n>      Maximum graph-node expansions
      --probability-floor <v>   Forward-mass floor for diagnostics
      --drain-equal-mass-band   Drain same-mass frontier band after iteration stop
      --exhaustive              Search until the frontier is empty or aborted
      --no-cache                Disable reusable search cache for this request

Output:
  -c, --clue <label>            Exact displayed clue, such as "Sharpness IV"
  -l, --summary-limit <n>       Maximum combo rows to include
      --uncapped-results        Allow very large combo output
      --sort <mode>             prob, count, or rank for human combo ordering
  -f, --format <format>         text, json, or raw-json
      --raw                     Shortcut for --format raw-json
  -h, --help                    Show this help
`;

const SEARCH_PRESETS = new Set<AnalyzerSearchPreset>(['coarse', 'standard', 'deep', 'ultra', 'exhaustive']);
const SORT_MODES = new Set<ResultSortMode>(['prob', 'count', 'rank']);
const OUTPUT_FORMATS = new Set<OutputFormat>(['text', 'json', 'raw-json']);
const TOP_ENCHANTMENT_COUNT = 10;
const PERCENT_SCALE = 100;
const TINY_PROBABILITY_THRESHOLD = 0.000001;
const PERCENT_DECIMAL_PLACES = 4;

async function main(argv: string[]): Promise<void> {
    const options = parseArgs(argv);
    if (options === 'help') {
        console.log(HELP);
        return;
    }

    const request = toAnalyzerRequest(options);
    const analyzer = EnchantingAnalyzer.forVersion(options.minecraftVersion!);

    if (options.format === 'raw-json') {
        const stats = await analyzer.analyzeRaw(request);
        writeJson(stats);
        return;
    }

    const insights = await analyzer.analyze(request, options.sortMode);
    if (options.format === 'json') {
        writeJson(insights);
        return;
    }

    writeText(options, insights);
}

function parseArgs(argv: string[]): CliOptions | 'help' {
    const options: CliOptions = {
        searchControls: {},
        format: 'text',
        sortMode: 'prob'
    };
    const positionals: string[] = [];

    for (let index = 0; index < argv.length; index++) {
        const raw = argv[index]!;
        if (!raw.startsWith('-')) {
            positionals.push(raw);
            continue;
        }

        const [flag, inlineValue] = splitFlag(raw);
        const value = () => inlineValue ?? argv[++index];

        switch (flag) {
            case '-h':
            case '--help':
                return 'help';
            case '-v':
            case '--version':
                options.minecraftVersion = parseVersion(flag, value());
                break;
            case '-i':
            case '--item':
                options.item = requireValue(flag, value());
                break;
            case '-m':
            case '--material':
                options.material = requireValue(flag, value());
                break;
            case '-x':
            case '--xp':
                options.xp = parseInteger(flag, value());
                break;
            case '-c':
            case '--clue':
                options.clue = requireValue(flag, value());
                break;
            case '-s':
            case '--search':
                options.searchPreset = parseSearchPreset(flag, value());
                break;
            case '--threshold':
                options.searchControls.threshold = parseProbability(flag, value());
                break;
            case '--target-mass':
            case '--target-classified-mass':
                options.searchControls.targetClassifiedMass = parseProbability(flag, value());
                break;
            case '--max-iterations':
                options.searchControls.maxIterations = parseInteger(flag, value());
                break;
            case '--probability-floor':
                options.searchControls.probabilityFloor = parseProbability(flag, value());
                break;
            case '--drain-equal-mass-band':
                options.searchControls.drainEqualMassBand = true;
                break;
            case '--exhaustive':
                options.searchControls.exhaustive = true;
                break;
            case '--no-cache':
                options.searchControls.useCache = false;
                break;
            case '-l':
            case '--summary-limit':
                options.summaryLimit = parseInteger(flag, value());
                break;
            case '--uncapped-results':
                options.uncappedResults = true;
                break;
            case '--sort':
                options.sortMode = parseSortMode(flag, value());
                break;
            case '-f':
            case '--format':
                options.format = parseOutputFormat(flag, value());
                break;
            case '--raw':
                options.format = 'raw-json';
                break;
            default:
                throw new Error(`Unknown option: ${raw}`);
        }
    }

    applyPositionals(options, positionals);

    const missing = [
        options.minecraftVersion === undefined ? 'version' : undefined,
        options.item === undefined ? 'item' : undefined,
        options.material === undefined ? 'material' : undefined,
        options.xp === undefined ? 'xp' : undefined
    ].filter((entry): entry is string => entry !== undefined);
    if (missing.length > 0) {
        throw new Error(`Missing required input${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
    }

    return options;
}

function splitFlag(raw: string): [string, string | undefined] {
    const equalsIndex = raw.indexOf('=');
    if (equalsIndex < 0) return [raw, undefined];
    return [raw.slice(0, equalsIndex), raw.slice(equalsIndex + 1)];
}

function applyPositionals(options: CliOptions, positionals: string[]): void {
    const slots = [
        {
            isMissing: () => options.minecraftVersion === undefined,
            assign: (value: string) => { options.minecraftVersion = parseVersion('<version>', value); }
        },
        {
            isMissing: () => options.item === undefined,
            assign: (value: string) => { options.item = value; }
        },
        {
            isMissing: () => options.material === undefined,
            assign: (value: string) => { options.material = value; }
        },
        {
            isMissing: () => options.xp === undefined,
            assign: (value: string) => { options.xp = parseInteger('<xp>', value); }
        }
    ];

    let positionalIndex = 0;
    for (const slot of slots) {
        if (!slot.isMissing() || positionalIndex >= positionals.length) continue;
        slot.assign(positionals[positionalIndex++]!);
    }

    if (positionalIndex < positionals.length) {
        throw new Error(`Unexpected positional argument${positionals.length - positionalIndex === 1 ? '' : 's'}: ${positionals.slice(positionalIndex).join(', ')}`);
    }
}

function requireValue(flag: string, value: string | undefined): string {
    if (value === undefined || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
    return value;
}

function parseVersion(flag: string, value: string | undefined): string {
    return requireValue(flag, value).trim().replace(/^v/i, '');
}

function parseInteger(flag: string, value: string | undefined): number {
    const text = requireValue(flag, value);
    const parsed = Number(text);
    if (!Number.isInteger(parsed)) throw new Error(`${flag} must be an integer, got "${text}".`);
    return parsed;
}

function parseProbability(flag: string, value: string | undefined): number {
    const text = requireValue(flag, value);
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a finite number, got "${text}".`);
    return parsed;
}

function parseSearchPreset(flag: string, value: string | undefined): AnalyzerSearchPreset {
    const text = requireValue(flag, value);
    if (!SEARCH_PRESETS.has(text as AnalyzerSearchPreset)) {
        throw new Error(`${flag} must be one of: ${[...SEARCH_PRESETS].join(', ')}.`);
    }
    return text as AnalyzerSearchPreset;
}

function parseSortMode(flag: string, value: string | undefined): ResultSortMode {
    const text = requireValue(flag, value);
    if (!SORT_MODES.has(text as ResultSortMode)) {
        throw new Error(`${flag} must be one of: ${[...SORT_MODES].join(', ')}.`);
    }
    return text as ResultSortMode;
}

function parseOutputFormat(flag: string, value: string | undefined): OutputFormat {
    const text = requireValue(flag, value);
    if (!OUTPUT_FORMATS.has(text as OutputFormat)) {
        throw new Error(`${flag} must be one of: ${[...OUTPUT_FORMATS].join(', ')}.`);
    }
    return text as OutputFormat;
}

function toAnalyzerRequest(options: CliOptions): AnalyzerRequest {
    const hasExplicitControls = Object.keys(options.searchControls).length > 0;
    const search = hasExplicitControls
        ? { ...(options.searchPreset === undefined ? {} : { preset: options.searchPreset }), ...options.searchControls }
        : options.searchPreset;

    return {
        item: options.item!,
        material: options.material!,
        xp: options.xp!,
        clue: options.clue,
        search,
        summaryLimit: options.summaryLimit,
        uncappedResults: options.uncappedResults
    };
}

function writeJson(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
}

function writeText(options: CliOptions, insights: Awaited<ReturnType<EnchantingAnalyzer['analyze']>>): void {
    const searchLabel = options.searchPreset ?? (Object.keys(options.searchControls).length > 0 ? 'custom' : 'standard');
    const comboEntries = Object.entries(insights.combos);
    const anyEntries = Object.entries(insights.any)
        .sort((left, right) => right[1] - left[1])
        .slice(0, TOP_ENCHANTMENT_COUNT);

    console.log('Minecraft Enchanting Analyzer');
    console.log(`${options.minecraftVersion} ${options.item}/${options.material} XP ${options.xp} search=${searchLabel}`);
    if (options.clue) console.log(`clue=${options.clue}`);
    console.log(`accuracy=${formatPercent(insights.accuracy)} pending=${formatPercent(insights.accounting.pending)} resolved=${formatPercent(insights.accounting.resolved)}`);

    if (comboEntries.length > 0) {
        console.log('');
        console.log('Top combinations');
        for (const [combo, share] of comboEntries) {
            console.log(`  ${formatPercent(share)}  ${combo}`);
        }
    }

    if (anyEntries.length > 0) {
        console.log('');
        console.log('Top enchantments');
        for (const [name, share] of anyEntries) {
            console.log(`  ${formatPercent(share)}  ${name}`);
        }
    }
}

function formatPercent(value: number): string {
    const percentage = value * PERCENT_SCALE;
    if (value === 0) return `${percentage.toFixed(PERCENT_DECIMAL_PLACES)}%`;
    if (Math.abs(value) < TINY_PROBABILITY_THRESHOLD) return `${percentage.toExponential(PERCENT_DECIMAL_PLACES)}%`;
    return `${percentage.toFixed(PERCENT_DECIMAL_PLACES)}%`;
}

main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Run with --help for usage.');
    process.exitCode = 1;
});
