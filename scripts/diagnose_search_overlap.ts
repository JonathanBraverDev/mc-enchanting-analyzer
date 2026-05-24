/**
 * V7 shared-search overlap diagnostic.
 *
 * Runs one XP-cell shared search and reports how much work is already shared by
 * SearchGraph identity, plus how much structural work might still be shared by
 * generalized pool families.
 *
 * Usage:
 *   npx tsx scripts/diagnose_search_overlap.ts --version 1.21.11 --item book --material book --xp 30
 *   npx tsx scripts/diagnose_search_overlap.ts --version 1.21.11 --item sword --material diamond --xp 30 --suffix-merging
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClueValidator } from '#core/clue.js';
import { RegistryFactory } from '#core/factory.js';
import { getEnchantName } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { RegistryKernel, type SearchPool } from '#lib/search/index.js';
import { SearchRun } from '#lib/search/SearchRun.js';
import { ProbUtils } from '#utils/index.js';

const DEFAULT_VERSION = '1.21.11';
const DEFAULT_ITEM = 'book';
const DEFAULT_MATERIAL = 'book';
const DEFAULT_XP = 30;
const DEFAULT_THRESHOLD = ENGINE_LIMITS.DEFAULT_THRESHOLD;
const TOP_GROUP_LIMIT = 10;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, 'diagnostics-output', 'search-overlap');

export interface SearchOverlapOptions {
    version: string;
    item: string;
    material: string;
    xp: number;
    clue?: string | undefined;
    threshold: number;
    maxIterations: number;
    targetClassifiedMass?: number | undefined;
    useSuffixMerging?: boolean | undefined;
}

export interface ContinueSignature {
    key: string;
    levels: number[];
    probabilityUnits: string[];
    probabilities: number[];
}

interface ModifiedLevelReport {
    modifiedLevel: number;
    distributionMass: number;
    distributionMassUnits: string;
    poolSignature: string;
    poolSize: number;
    graphId: number | null;
    fullContinueSignature: string;
    tailContinueSignature: string;
}

interface OverlapGroupReport {
    key: string;
    levels: number[];
    levelCount: number;
    distributionMass: number;
    distributionMassUnits: string;
    poolSize?: number | undefined;
}

interface TemplateSavingsGroup {
    key: string;
    occurrences: number;
    graphCount: number;
    currentCandidateChecks: number;
    templateCandidateChecks: number;
    netSavedCandidateChecks: number;
}

interface TemplateSavingsReport {
    uniqueTemplates: number;
    templateCandidateChecks: number;
    netSavedCandidateChecks: number;
    netSavedRatio: number;
    topSavingsGroups: TemplateSavingsGroup[];
}

interface GeneralizedPoolFamilyReport {
    key: string;
    exactPoolSignatures: string[];
    baseEnchantCount: number;
    packedCandidateCount: number;
    rankVariantEnchantCount: number;
    rankVariantEnchantments: Array<{
        enchantId: number;
        name: string;
        packedEnchants: string[];
    }>;
}

interface SuffixMergingReport {
    enabled: boolean;
    canonicalEntryCount: number;
    hits: number;
    misses: number;
    mergedPendingMass: number;
    mergedPendingMassUnits: string;
    avoidedPendingEntries: number;
}

export interface SearchOverlapReport {
    metadata: SearchOverlapOptions & {
        generatedAt: string;
        elapsedMs: number;
        targetClueId: number | null;
    };
    summary: {
        modifiedLevelCount: number;
        totalDistributionMass: number;
        graphCount: number;
        graphNodeCount: number;
        graphExpansionCount: number;
        pendingEntryCount: number;
        resultCount: number;
        classifiedMass: number;
        resolvedMass: number;
        pendingMass: number;
        iterations: number;
        lastExpandedMass: number;
        largestPendingMass: number;
        uniquePools: number;
        uniqueFullContinueSignatures: number;
        uniqueTailContinueSignatures: number;
        uniquePoolTailContinueGroups: number;
        currentCandidateChecks: number;
        blueprintHits: number;
        blueprintMisses: number;
        blueprintCandidateChecks: number;
        blueprintSavedCandidateChecks: number;
        blueprintSavingsRatio: number;
        suffixMergeHits: number;
        suffixMergeMisses: number;
        suffixAvoidedPendingEntries: number;
        exactTemplateSavingsRatio: number;
        generalizedTemplateSavingsRatio: number;
    };
    levels: ModifiedLevelReport[];
    groups: {
        pools: OverlapGroupReport[];
        fullContinue: OverlapGroupReport[];
        tailContinue: OverlapGroupReport[];
        poolTailContinue: OverlapGroupReport[];
    };
    graphs: Array<{
        graphId: number;
        poolSignature: string;
        generalizedFamilyKey: string;
        poolSize: number;
        nodeCount: number;
        expansionCount: number;
    }>;
    templateOverlap: {
        currentCandidateChecks: number;
        exact: TemplateSavingsReport;
        generalized: TemplateSavingsReport;
    };
    blueprints: {
        hits: number;
        misses: number;
        baselineCandidateChecks: number;
        blueprintCandidateChecks: number;
        savedCandidateChecks: number;
        savedRatio: number;
    };
    suffixMerging: SuffixMergingReport;
    generalizedPoolFamilies: GeneralizedPoolFamilyReport[];
}

interface MutableGroup {
    key: string;
    levels: number[];
    distributionMassUnits: bigint;
    poolSize?: number | undefined;
}

interface MutableTemplateGroup {
    occurrences: number;
    graphIds: Set<number>;
    currentCandidateChecks: number;
    templateCandidateChecks: number;
}

export function getContinueSignature(level: number, tail = false): ContinueSignature {
    const levels = getContinueLevelPath(level, tail);
    const probabilities = levels.map(currentLevel => ProbUtils.PROB_CONTINUE_TABLE[currentLevel] ?? 0n);
    return {
        key: probabilities.map(probability => probability.toString()).join('>'),
        levels,
        probabilityUnits: probabilities.map(probability => probability.toString()),
        probabilities: probabilities.map(probability => ProbUtils.toNumber(probability))
    };
}

export async function generateSearchOverlapReport(options: SearchOverlapOptions): Promise<SearchOverlapReport> {
    const start = performance.now();
    const registry = RegistryFactory.build(options.version);
    const kernel = new RegistryKernel({ registry, item: options.item, material: options.material });
    const distributionService = new ModifiedLevelDistributionService();
    const targetClueId = options.clue ? ClueValidator.validate(registry, options.item, options.clue) : undefined;
    const distribution = distributionService.getModifiedLevelDist(registry, options.xp, kernel.enchantability);
    const levels = Object.keys(distribution).map(Number).sort((a, b) => b - a);

    const poolGroups = new Map<string, MutableGroup>();
    const fullContinueGroups = new Map<string, MutableGroup>();
    const tailContinueGroups = new Map<string, MutableGroup>();
    const poolTailContinueGroups = new Map<string, MutableGroup>();
    const poolsBySignature = new Map<string, SearchPool>();
    const levelReports: ModifiedLevelReport[] = [];
    let totalDistributionMassUnits = 0n;

    for (const level of levels) {
        const distributionMassUnits = distribution[level] ?? 0n;
        if (distributionMassUnits === 0n) continue;
        totalDistributionMassUnits += distributionMassUnits;

        const pool = kernel.getPool(level);
        const poolSignature = String(pool.signature);
        poolsBySignature.set(poolSignature, pool);

        const fullContinue = getContinueSignature(level);
        const tailContinue = getContinueSignature(level, true);
        addGroup(poolGroups, poolSignature, level, distributionMassUnits, pool.entries.length);
        addGroup(fullContinueGroups, fullContinue.key, level, distributionMassUnits);
        addGroup(tailContinueGroups, tailContinue.key, level, distributionMassUnits);
        addGroup(poolTailContinueGroups, `${poolSignature}|${tailContinue.key}`, level, distributionMassUnits, pool.entries.length);

        levelReports.push({
            modifiedLevel: level,
            distributionMass: ProbUtils.toNumber(distributionMassUnits),
            distributionMassUnits: distributionMassUnits.toString(),
            poolSignature,
            poolSize: pool.entries.length,
            graphId: null,
            fullContinueSignature: fullContinue.key,
            tailContinueSignature: tailContinue.key
        });
    }

    const run = new SearchRun(kernel, {
        distributionService,
        targetClueId,
        useSuffixMerging: options.useSuffixMerging ?? false
    });
    run.seedXp(options.xp);
    const snapshot = run.searchToCheckpoint({
        threshold: options.threshold,
        maxIterations: options.maxIterations,
        targetClassifiedMass: options.targetClassifiedMass
    });
    const graphDiagnostics = run.getGraphDiagnostics(true);
    const graphIdByPool = new Map(graphDiagnostics.map(graph => [String(graph.key.poolSignature), graph.graphId]));
    for (const report of levelReports) report.graphId = graphIdByPool.get(report.poolSignature) ?? null;

    const generalizedFamilies = buildGeneralizedPoolFamilies(registry, [...poolsBySignature.values()]);
    const familyByPool = new Map<string, GeneralizedPoolFamilyReport>();
    for (const family of generalizedFamilies) {
        for (const signature of family.exactPoolSignatures) familyByPool.set(signature, family);
    }

    const exactTemplates = new Map<string, MutableTemplateGroup>();
    const generalizedTemplates = new Map<string, MutableTemplateGroup>();
    let currentCandidateChecks = 0;

    for (const graph of graphDiagnostics) {
        const poolSignature = String(graph.key.poolSignature);
        const family = familyByPool.get(poolSignature);
        const baseCandidateCount = family?.baseEnchantCount ?? graph.poolSize;

        for (const materialized of graph.nodes) {
            if (!materialized.hasExpansion) continue;
            const node = materialized.node;
            currentCandidateChecks += graph.poolSize;
            addTemplateGroup(
                exactTemplates,
                [poolSignature, node.selectedMask.toString(16), node.currentLevel, node.count].join('|'),
                graph.graphId,
                graph.poolSize,
                graph.poolSize
            );
            addTemplateGroup(
                generalizedTemplates,
                [family?.key ?? poolSignature, node.selectedMask.toString(16), node.currentLevel, node.count].join('|'),
                graph.graphId,
                graph.poolSize,
                baseCandidateCount
            );
        }
    }

    const exactTemplateSavings = summarizeTemplateSavings(currentCandidateChecks, exactTemplates);
    const generalizedTemplateSavings = summarizeTemplateSavings(currentCandidateChecks, generalizedTemplates);
    const graphNodeCount = graphDiagnostics.reduce((sum, graph) => sum + graph.nodeCount, 0);
    const graphExpansionCount = graphDiagnostics.reduce((sum, graph) => sum + graph.expansionCount, 0);
    const blueprintMetrics = summarizeBlueprintMetrics(graphDiagnostics);
    const suffixMerging = summarizeSuffixMerging(snapshot.suffixMerging);

    return {
        metadata: {
            ...options,
            generatedAt: new Date().toISOString(),
            elapsedMs: Math.round(performance.now() - start),
            targetClueId: targetClueId ?? null
        },
        summary: {
            modifiedLevelCount: levelReports.length,
            totalDistributionMass: ProbUtils.toNumber(totalDistributionMassUnits),
            graphCount: graphDiagnostics.length,
            graphNodeCount,
            graphExpansionCount,
            pendingEntryCount: snapshot.pendingCount,
            resultCount: snapshot.results.size,
            classifiedMass: 1 - snapshot.mass.pending,
            resolvedMass: snapshot.mass.resolved,
            pendingMass: snapshot.mass.pending,
            iterations: snapshot.iterations,
            lastExpandedMass: ProbUtils.toNumber(snapshot.lastExpandedMass),
            largestPendingMass: ProbUtils.toNumber(snapshot.largestPendingMass),
            uniquePools: poolGroups.size,
            uniqueFullContinueSignatures: fullContinueGroups.size,
            uniqueTailContinueSignatures: tailContinueGroups.size,
            uniquePoolTailContinueGroups: poolTailContinueGroups.size,
            currentCandidateChecks,
            blueprintHits: blueprintMetrics.hits,
            blueprintMisses: blueprintMetrics.misses,
            blueprintCandidateChecks: blueprintMetrics.blueprintCandidateChecks,
            blueprintSavedCandidateChecks: blueprintMetrics.savedCandidateChecks,
            blueprintSavingsRatio: blueprintMetrics.savedRatio,
            suffixMergeHits: suffixMerging.hits,
            suffixMergeMisses: suffixMerging.misses,
            suffixAvoidedPendingEntries: suffixMerging.avoidedPendingEntries,
            exactTemplateSavingsRatio: exactTemplateSavings.netSavedRatio,
            generalizedTemplateSavingsRatio: generalizedTemplateSavings.netSavedRatio
        },
        levels: levelReports,
        groups: {
            pools: summarizeGroups(poolGroups),
            fullContinue: summarizeGroups(fullContinueGroups),
            tailContinue: summarizeGroups(tailContinueGroups),
            poolTailContinue: summarizeGroups(poolTailContinueGroups)
        },
        graphs: graphDiagnostics.map(graph => {
            const poolSignature = String(graph.key.poolSignature);
            return {
                graphId: graph.graphId,
                poolSignature,
                generalizedFamilyKey: familyByPool.get(poolSignature)?.key ?? poolSignature,
                poolSize: graph.poolSize,
                nodeCount: graph.nodeCount,
                expansionCount: graph.expansionCount
            };
        }),
        templateOverlap: {
            currentCandidateChecks,
            exact: exactTemplateSavings,
            generalized: generalizedTemplateSavings
        },
        blueprints: blueprintMetrics,
        suffixMerging,
        generalizedPoolFamilies: generalizedFamilies
    };
}

export function formatSearchOverlapSummary(report: SearchOverlapReport): string {
    const lines: string[] = [];
    lines.push(`V7 search overlap: ${report.metadata.version} ${report.metadata.item}/${report.metadata.material} xp=${report.metadata.xp}`);
    if (report.metadata.clue) lines.push(`Clue: ${report.metadata.clue}`);
    lines.push(`Threshold=${report.metadata.threshold} limit=${report.metadata.maxIterations}${report.metadata.targetClassifiedMass ? ` targetClassified=${formatPercent(report.metadata.targetClassifiedMass)}` : ''} suffix=${report.suffixMerging.enabled ? 'on' : 'off'}`);
    lines.push(`Elapsed: ${report.metadata.elapsedMs}ms`);
    lines.push('');
    lines.push('Summary');
    lines.push(`  Modified levels: ${report.summary.modifiedLevelCount}`);
    lines.push(`  Graphs: ${report.summary.graphCount}, nodes=${report.summary.graphNodeCount}, expansions=${report.summary.graphExpansionCount}`);
    lines.push(`  Classified=${formatPercent(report.summary.classifiedMass)} pending=${formatPercent(report.summary.pendingMass)} iterations=${report.summary.iterations}`);
    lines.push(`  Last expanded mass=${formatPercent(report.summary.lastExpandedMass)} largest pending=${formatPercent(report.summary.largestPendingMass)}`);
    lines.push(`  Unique pools=${report.summary.uniquePools}, tail continue signatures=${report.summary.uniqueTailContinueSignatures}, pool+tail=${report.summary.uniquePoolTailContinueGroups}`);
    lines.push(`  Candidate checks=${report.summary.currentCandidateChecks}, exact template savings=${formatSignedPercent(report.summary.exactTemplateSavingsRatio)}, generalized template estimate=${formatSignedPercent(report.summary.generalizedTemplateSavingsRatio)}`);
    lines.push(`  Blueprint checks=${report.blueprints.blueprintCandidateChecks}/${report.blueprints.baselineCandidateChecks}, hits=${report.blueprints.hits}, misses=${report.blueprints.misses}, actual savings=${formatSignedPercent(report.blueprints.savedRatio)}`);
    lines.push(`  Suffix merges=${report.suffixMerging.hits}/${report.suffixMerging.misses}, canonical=${report.suffixMerging.canonicalEntryCount}, avoided=${report.suffixMerging.avoidedPendingEntries}, mergedMass=${formatPercent(report.suffixMerging.mergedPendingMass)}`);
    lines.push('');
    appendTopGroups(lines, 'Top pool groups by distribution mass', report.groups.pools);
    appendTopGroups(lines, 'Top tail-continue groups by distribution mass', report.groups.tailContinue);
    appendTopTemplateGroups(lines, 'Top generalized template savings', report.templateOverlap.generalized.topSavingsGroups);
    return lines.join('\n');
}

function summarizeBlueprintMetrics(graphs: readonly { blueprints: {
    hits: number;
    misses: number;
    baselineCandidateChecks: number;
    blueprintCandidateChecks: number;
    savedCandidateChecks: number;
} }[]): SearchOverlapReport['blueprints'] {
    const metrics = graphs.reduce(
        (sum, graph) => {
            sum.hits += graph.blueprints.hits;
            sum.misses += graph.blueprints.misses;
            sum.baselineCandidateChecks += graph.blueprints.baselineCandidateChecks;
            sum.blueprintCandidateChecks += graph.blueprints.blueprintCandidateChecks;
            sum.savedCandidateChecks += graph.blueprints.savedCandidateChecks;
            return sum;
        },
        {
            hits: 0,
            misses: 0,
            baselineCandidateChecks: 0,
            blueprintCandidateChecks: 0,
            savedCandidateChecks: 0
        }
    );

    return {
        ...metrics,
        savedRatio: metrics.baselineCandidateChecks === 0
            ? 0
            : metrics.savedCandidateChecks / metrics.baselineCandidateChecks
    };
}

function summarizeSuffixMerging(metrics: {
    enabled: boolean;
    canonicalEntryCount: number;
    hits: number;
    misses: number;
    mergedPendingMass: bigint;
    avoidedPendingEntries: number;
}): SuffixMergingReport {
    return {
        enabled: metrics.enabled,
        canonicalEntryCount: metrics.canonicalEntryCount,
        hits: metrics.hits,
        misses: metrics.misses,
        mergedPendingMass: ProbUtils.toNumber(metrics.mergedPendingMass),
        mergedPendingMassUnits: metrics.mergedPendingMass.toString(),
        avoidedPendingEntries: metrics.avoidedPendingEntries
    };
}

function getContinueLevelPath(level: number, tail: boolean): number[] {
    const levels: number[] = [];
    let current = tail ? Math.floor(level / 2) : level;
    while (true) {
        levels.push(current);
        if (current === 0) break;
        current = Math.floor(current / 2);
    }
    return levels;
}

function buildGeneralizedPoolFamilies(
    registry: ReturnType<typeof RegistryFactory.build>,
    pools: SearchPool[]
): GeneralizedPoolFamilyReport[] {
    const families = new Map<string, { pools: SearchPool[]; packedByEnchant: Map<number, Set<number>> }>();

    for (const pool of pools) {
        const key = String(pool.familySignature);
        let family = families.get(key);
        if (!family) {
            family = { pools: [], packedByEnchant: new Map() };
            families.set(key, family);
        }
        family.pools.push(pool);
        for (const entry of pool.entries) {
            let packed = family.packedByEnchant.get(entry.enchantId);
            if (!packed) {
                packed = new Set<number>();
                family.packedByEnchant.set(entry.enchantId, packed);
            }
            packed.add(entry.packedEnchant);
        }
    }

    return [...families.entries()].map(([key, family]) => {
        const rankVariantEnchantments = [...family.packedByEnchant.entries()]
            .map(([enchantId, packed]) => ({
                enchantId,
                name: getEnchantName(registry, enchantId),
                packedEnchants: [...packed].sort((a, b) => a - b).map(value => value.toString(16))
            }))
            .filter(entry => entry.packedEnchants.length > 1)
            .sort((a, b) => b.packedEnchants.length - a.packedEnchants.length || a.enchantId - b.enchantId);

        return {
            key,
            exactPoolSignatures: family.pools.map(pool => String(pool.signature)).sort(),
            baseEnchantCount: family.packedByEnchant.size,
            packedCandidateCount: [...family.packedByEnchant.values()].reduce((sum, packed) => sum + packed.size, 0),
            rankVariantEnchantCount: rankVariantEnchantments.length,
            rankVariantEnchantments
        };
    }).sort((a, b) => b.exactPoolSignatures.length - a.exactPoolSignatures.length);
}

function addGroup(groups: Map<string, MutableGroup>, key: string, level: number, distributionMassUnits: bigint, poolSize?: number): void {
    let group = groups.get(key);
    if (!group) {
        group = { key, levels: [], distributionMassUnits: 0n, poolSize };
        groups.set(key, group);
    }
    group.levels.push(level);
    group.distributionMassUnits += distributionMassUnits;
    if (poolSize !== undefined) group.poolSize = poolSize;
}

function summarizeGroups(groups: Map<string, MutableGroup>): OverlapGroupReport[] {
    return [...groups.values()]
        .map(group => ({
            key: group.key,
            levels: [...group.levels].sort((a, b) => b - a),
            levelCount: group.levels.length,
            distributionMass: ProbUtils.toNumber(group.distributionMassUnits),
            distributionMassUnits: group.distributionMassUnits.toString(),
            poolSize: group.poolSize
        }))
        .sort((a, b) => b.distributionMass - a.distributionMass);
}

function addTemplateGroup(
    groups: Map<string, MutableTemplateGroup>,
    key: string,
    graphId: number,
    currentCandidateChecks: number,
    templateCandidateChecks: number
): void {
    let group = groups.get(key);
    if (!group) {
        group = {
            occurrences: 0,
            graphIds: new Set<number>(),
            currentCandidateChecks: 0,
            templateCandidateChecks
        };
        groups.set(key, group);
    }
    group.occurrences++;
    group.graphIds.add(graphId);
    group.currentCandidateChecks += currentCandidateChecks;
}

function summarizeTemplateSavings(totalCandidateChecks: number, groups: Map<string, MutableTemplateGroup>): TemplateSavingsReport {
    const templateCandidateChecks = [...groups.values()].reduce((sum, group) => sum + group.templateCandidateChecks, 0);
    const netSavedCandidateChecks = totalCandidateChecks - templateCandidateChecks;
    return {
        uniqueTemplates: groups.size,
        templateCandidateChecks,
        netSavedCandidateChecks,
        netSavedRatio: totalCandidateChecks === 0 ? 0 : netSavedCandidateChecks / totalCandidateChecks,
        topSavingsGroups: [...groups.entries()]
            .map(([key, group]) => ({
                key,
                occurrences: group.occurrences,
                graphCount: group.graphIds.size,
                currentCandidateChecks: group.currentCandidateChecks,
                templateCandidateChecks: group.templateCandidateChecks,
                netSavedCandidateChecks: group.currentCandidateChecks - group.templateCandidateChecks
            }))
            .filter(group => group.netSavedCandidateChecks > 0)
            .sort((a, b) => b.netSavedCandidateChecks - a.netSavedCandidateChecks)
            .slice(0, TOP_GROUP_LIMIT)
    };
}

function appendTopGroups(lines: string[], title: string, groups: OverlapGroupReport[]): void {
    lines.push(title);
    for (const group of groups.slice(0, TOP_GROUP_LIMIT)) {
        lines.push(`  mass=${formatPercent(group.distributionMass)} levels=${group.levels.join(',')} key=${shortKey(group.key)}`);
    }
    if (groups.length === 0) lines.push('  none');
    lines.push('');
}

function appendTopTemplateGroups(lines: string[], title: string, groups: TemplateSavingsGroup[]): void {
    lines.push(title);
    for (const group of groups) {
        lines.push(`  saved=${group.netSavedCandidateChecks} occurrences=${group.occurrences} graphs=${group.graphCount} key=${shortKey(group.key)}`);
    }
    if (groups.length === 0) lines.push('  none');
    lines.push('');
}

function parseCliOptions(args: string[]): SearchOverlapOptions & { stdoutJson: boolean } {
    const findArg = (key: string): string | null => {
        const index = args.indexOf(key);
        const raw = index >= 0 ? args[index + 1] : undefined;
        return raw && !raw.startsWith('--') ? raw : null;
    };
    const hasFlag = (key: string): boolean => args.includes(key);

    return {
        version: findArg('--version') ?? DEFAULT_VERSION,
        item: findArg('--item') ?? DEFAULT_ITEM,
        material: findArg('--material') ?? DEFAULT_MATERIAL,
        xp: Number.parseInt(findArg('--xp') ?? String(DEFAULT_XP), 10),
        clue: findArg('--clue') ?? undefined,
        threshold: Number(findArg('--threshold') ?? DEFAULT_THRESHOLD),
        maxIterations: Number.parseInt(findArg('--limit') ?? findArg('--max-iterations') ?? String(ENGINE_LIMITS.SEARCH_ITERATION_SAFETY_CAP), 10),
        targetClassifiedMass: parseOptionalNumber(findArg('--target-classified-mass') ?? findArg('--mass-target')),
        useSuffixMerging: hasFlag('--suffix-merging'),
        stdoutJson: hasFlag('--stdout-json') || hasFlag('--json')
    };
}

function parseOptionalNumber(raw: string | null): number | undefined {
    if (raw === null) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function getOutputPath(report: SearchOverlapReport): string {
    const cluePart = report.metadata.clue ? `_clue_${safeFilePart(report.metadata.clue)}` : '';
    const name = [
        safeFilePart(report.metadata.version),
        safeFilePart(report.metadata.item),
        safeFilePart(report.metadata.material),
        `xp${report.metadata.xp}${cluePart}`,
        Date.now()
    ].join('_');
    return path.join(OUT_DIR, `${name}.json`);
}

function safeFilePart(input: string): string {
    return input.replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '');
}

function shortKey(key: string): string {
    return key.length <= 80 ? key : `${key.slice(0, 77)}...`;
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(4)}%`;
}

function formatSignedPercent(value: number): string {
    return `${value > 0 ? '+' : ''}${formatPercent(value)}`;
}

async function main(): Promise<void> {
    const { stdoutJson, ...options } = parseCliOptions(process.argv.slice(2));
    const report = await generateSearchOverlapReport(options);

    if (stdoutJson) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outFile = getOutputPath(report);
    fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(formatSearchOverlapSummary(report));
    console.log(`JSON: ${outFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
