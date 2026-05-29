import { performance } from 'node:perf_hooks';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { RegistryFactory } from '#core/factory.js';
import { getEnchantName } from '#core/registry.js';
import { RegistryKernel, type SearchPool, type SearchPoolEntry, type SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import { GroupedFlexSearchRun } from '#lib/search/flex/index.js';
import type { RegistryState } from '#types/index.js';
import { PRECISION } from '#utils/index.js';

interface CaseSpec {
    readonly version: string;
    readonly item: string;
    readonly material: string;
    readonly xp: number;
}

interface LevelPool {
    readonly level: number;
    readonly mass: bigint;
    readonly childLevel: number;
    readonly pool: SearchPool;
    readonly structureKey: string;
    readonly familyKey: string;
    readonly exactKey: string;
    readonly structuralIds: readonly number[];
}

const CASES: readonly CaseSpec[] = [
    { version: '1.21.11', item: 'book', material: 'book', xp: 30 },
    { version: '1.21.11', item: 'sword', material: 'diamond', xp: 30 },
    { version: '1.21.11', item: 'helmet', material: 'diamond', xp: 30 },
    { version: '1.21.11', item: 'chestplate', material: 'diamond', xp: 30 },
    { version: '1.14', item: 'chestplate', material: 'diamond', xp: 30 },
    { version: '1.8', item: 'sword', material: 'diamond', xp: 30 },
    { version: '1.7.2', item: 'book', material: 'book', xp: 30 }
];

for (const spec of CASES) {
    reportCase(spec);
}

function reportCase(spec: CaseSpec): void {
    const registry = RegistryFactory.build(spec.version);
    const kernel = new RegistryKernel({ registry, item: spec.item, material: spec.material });
    const distribution = new ModifiedLevelDistributionService().getModifiedLevelDist(
        registry,
        spec.xp,
        kernel.enchantability
    );
    const divisor = kernel.additionalEnchantmentLevelDivisor;
    const levels: LevelPool[] = Object.entries(distribution)
        .filter(([, mass]) => mass > 0n)
        .map(([levelText, mass]) => {
            const level = Number(levelText);
            const pool = kernel.getPool(level);
            return {
                level,
                mass,
                childLevel: Math.floor(level / divisor),
                pool,
                structureKey: structureKey(pool.entries),
                familyKey: pool.familySignature,
                exactKey: pool.signature,
                structuralIds: structuralIds(pool.entries)
            };
        })
        .sort((left, right) => left.level - right.level);

    const childGroups = groupBy(levels, level => String(level.childLevel));
    const exactGraphs = new Set(levels.map(level => level.exactKey)).size;
    const familyGroups = countMergedGroups(levels, level => `${level.childLevel}|${level.familyKey}`);
    const structureGroups = countMergedGroups(levels, level => `${level.childLevel}|${level.structureKey}`);
    const childOnlyGroups = countMergedGroups(levels, level => String(level.childLevel));
    const rootEdgeStats = rootEdgeUnionStats(childGroups);
    const nearPairs = findNearPairs(registry, childGroups);
    const graphProbe = estimateFamilyGraphMerge(spec, spec.xp);

    console.log('');
    console.log(`${spec.version} ${spec.item}/${spec.material} XP ${spec.xp}`);
    console.log(`levels=${levels.length} exactGraphs=${exactGraphs} childLevelGroups=${childGroups.size}`);
    console.log(`same childLevel merge upper bound: groups=${childOnlyGroups.groups} savedRoots=${childOnlyGroups.saved} mass=${pct(childOnlyGroups.mass)}`);
    console.log(`rank-only/family within childLevel: groups=${familyGroups.groups} savedRoots=${familyGroups.saved} mass=${pct(familyGroups.mass)}`);
    console.log(`same structural ids within childLevel: groups=${structureGroups.groups} savedRoots=${structureGroups.saved} mass=${pct(structureGroups.mass)}`);
    console.log(`root edge union: currentEdges=${rootEdgeStats.currentEdges} unionEdges=${rootEdgeStats.unionEdges} saved=${rootEdgeStats.currentEdges - rootEdgeStats.unionEdges}`);
    console.log(`99.5 rank-family search probe: graphs ${graphProbe.original.graphs}->${graphProbe.family.graphs}, nodes ${graphProbe.original.nodes}->${graphProbe.family.nodes} saved=${graphProbe.nodeSaved} (${graphProbe.nodeSavedPct}), search ${graphProbe.original.searchMs}->${graphProbe.family.searchMs}ms`);
    console.log(`near-one structural pairs=${nearPairs.length}`);
    for (const pair of nearPairs.slice(0, 8)) {
        console.log(`  L${pair.a.level}/L${pair.b.level}->${pair.a.childLevel} diff=${pair.diffNames.join(' vs ')} commonMergeableAfterPick=${pair.mergeableCommonPicks}/${pair.commonPicks}`);
    }
}

function estimateFamilyGraphMerge(spec: CaseSpec, xp: number): {
    readonly original: SearchStats;
    readonly family: SearchStats;
    readonly nodeSaved: number;
    readonly nodeSavedPct: string;
} {
    const original = runSearchStats(new RegistryKernel({
        registry: RegistryFactory.build(spec.version),
        item: spec.item,
        material: spec.material
    }), xp);
    const family = runSearchStats(createFamilySignatureKernel(spec), xp);
    const nodeSaved = original.nodes - family.nodes;

    return {
        original,
        family,
        nodeSaved,
        nodeSavedPct: original.nodes === 0 ? '0.0%' : `${(100 * nodeSaved / original.nodes).toFixed(1)}%`
    };
}

interface SearchStats {
    readonly graphs: number;
    readonly nodes: number;
    readonly iterations: number;
    readonly searchMs: number;
}

function runSearchStats(kernel: RegistryKernel, xp: number): SearchStats {
    const run = new GroupedFlexSearchRun(kernel);
    run.seedXp(xp);

    const started = performance.now();
    const state = run.searchToCheckpointState({ targetClassifiedMass: 0.995, probabilityFloor: 0n });
    const searchMs = Math.round(performance.now() - started);
    const memory = run.getMemoryStats();
    return {
        graphs: memory.graphs.length,
        nodes: sumNumbers(memory.graphs.map(graph => graph.nodeCount)),
        iterations: state.iterations,
        searchMs
    };
}

function createFamilySignatureKernel(spec: CaseSpec): RegistryKernel {
    const kernel = new RegistryKernel({
        registry: RegistryFactory.build(spec.version),
        item: spec.item,
        material: spec.material
    });
    const getPool = kernel.getPool.bind(kernel);
    const representatives = new Map<string, SearchPool>();
    (kernel as unknown as { getPool(level: number): SearchPool }).getPool = (level: number): SearchPool => {
        const pool = getPool(level);
        const existing = representatives.get(pool.familySignature);
        if (existing) return existing;

        const representative = Object.freeze({
            ...pool,
            signature: `rank-family:${pool.familySignature}` as SearchPoolSignature
        });
        representatives.set(pool.familySignature, representative);
        return representative;
    };
    return kernel;
}

function countMergedGroups(levels: readonly LevelPool[], keyOf: (level: LevelPool) => string): {
    readonly groups: number;
    readonly saved: number;
    readonly mass: bigint;
} {
    let groups = 0;
    let saved = 0;
    let mass = 0n;
    for (const group of groupBy(levels, keyOf).values()) {
        const exactCount = new Set(group.map(level => level.exactKey)).size;
        if (exactCount <= 1) continue;
        groups++;
        saved += exactCount - 1;
        mass += sumMass(group);
    }
    return { groups, saved, mass };
}

function rootEdgeUnionStats(childGroups: Map<string, LevelPool[]>): {
    readonly currentEdges: number;
    readonly unionEdges: number;
} {
    let currentEdges = 0;
    let unionEdges = 0;
    for (const group of childGroups.values()) {
        const uniquePools = uniqueBy(group, level => level.exactKey);
        const union = new Set<string>();
        for (const level of uniquePools) {
            const edges = rootChildKeys(level.pool.entries);
            currentEdges += edges.size;
            for (const edge of edges) union.add(edge);
        }
        unionEdges += union.size;
    }
    return { currentEdges, unionEdges };
}

function findNearPairs(registry: RegistryState, childGroups: Map<string, LevelPool[]>): Array<{
    readonly a: LevelPool;
    readonly b: LevelPool;
    readonly diffNames: readonly string[];
    readonly commonPicks: number;
    readonly mergeableCommonPicks: number;
}> {
    const out: Array<{
        readonly a: LevelPool;
        readonly b: LevelPool;
        readonly diffNames: readonly string[];
        readonly commonPicks: number;
        readonly mergeableCommonPicks: number;
    }> = [];
    for (const group of childGroups.values()) {
        for (let left = 0; left < group.length; left++) {
            for (let right = left + 1; right < group.length; right++) {
                const a = group[left]!;
                const b = group[right]!;
                if (a.exactKey === b.exactKey) continue;
                const diff = symmetricDiff(new Set(a.structuralIds), new Set(b.structuralIds));
                if (diff.length !== 1 && diff.length !== 2) continue;

                const commonEntries = commonStructuralEntries(a.pool.entries, b.pool.entries);
                let mergeableCommonPicks = 0;
                for (const entry of commonEntries) {
                    if (remainingStructureKey(a.pool.entries, entry.blocksBitset) === remainingStructureKey(b.pool.entries, entry.blocksBitset)) {
                        mergeableCommonPicks++;
                    }
                }
                out.push({
                    a,
                    b,
                    diffNames: diff.map(id => getEnchantName(registry, id)),
                    commonPicks: commonEntries.length,
                    mergeableCommonPicks
                });
            }
        }
    }
    return out.sort((left, right) => {
        const leftMass = left.a.mass + left.b.mass;
        const rightMass = right.a.mass + right.b.mass;
        return leftMass > rightMass ? -1 : leftMass < rightMass ? 1 : left.a.level - right.a.level;
    });
}

function commonStructuralEntries(a: readonly SearchPoolEntry[], b: readonly SearchPoolEntry[]): readonly SearchPoolEntry[] {
    const bIds = new Set(b.map(entry => entry.enchantId));
    return a.filter(entry => bIds.has(entry.enchantId));
}

function rootChildKeys(entries: readonly SearchPoolEntry[]): Set<string> {
    return new Set(entries.map(entry => `${entry.blocksBitset.toString(16)}|${entry.weight}`));
}

function structureKey(entries: readonly SearchPoolEntry[]): string {
    return entries
        .map(entry => `${entry.enchantId}:${entry.weight}:${entry.conflictBitset.toString(16)}`)
        .join(',');
}

function remainingStructureKey(entries: readonly SearchPoolEntry[], exclusionMask: bigint): string {
    return entries
        .filter(entry => (exclusionMask & entry.idBit) === 0n)
        .map(entry => `${entry.enchantId}:${entry.weight}:${entry.conflictBitset.toString(16)}`)
        .join(',');
}

function structuralIds(entries: readonly SearchPoolEntry[]): readonly number[] {
    return entries.map(entry => entry.enchantId);
}

function symmetricDiff(left: Set<number>, right: Set<number>): number[] {
    const out: number[] = [];
    for (const value of left) {
        if (!right.has(value)) out.push(value);
    }
    for (const value of right) {
        if (!left.has(value)) out.push(value);
    }
    return out.sort((a, b) => a - b);
}

function groupBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const value of values) {
        const key = keyOf(value);
        let group = groups.get(key);
        if (!group) {
            group = [];
            groups.set(key, group);
        }
        group.push(value);
    }
    return groups;
}

function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const value of values) {
        const key = keyOf(value);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
    }
    return out;
}

function sumMass(levels: readonly LevelPool[]): bigint {
    let total = 0n;
    for (const level of levels) total += level.mass;
    return total;
}

function sumNumbers(values: readonly number[]): number {
    let total = 0;
    for (const value of values) total += value;
    return total;
}

function pct(value: bigint): string {
    return `${(Number(value * 100000n / PRECISION) / 1000).toFixed(3)}%`;
}
