import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { BIGINT_CONSTANTS, PACKING_CONSTANTS } from '#constants/engine.js';
import type { SearchPool } from '#lib/search/registry/RegistryKernel.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { PRECISION, ProbUtils } from '#utils/index.js';
import type {
    FlexCheckpointRequest,
    FlexNodeId,
    FlexOptimizationControls,
    FlexPoolProfile,
    FlexRankMergeMemoryStats,
    FlexRunState,
    FlexRunSnapshot,
    FlexRunMemoryStats,
    FlexStateIdentityMode
} from '#lib/search/flex/FlexTypes.js';
import { FlexCoordinator } from '#lib/search/flex/FlexCoordinator.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';
import { FlexPoolProfileStore } from '#lib/search/flex/FlexPoolProfileStore.js';
import { FlexResultKeyStore } from '#lib/search/flex/FlexResultKeyStore.js';
import { FlexProjector } from '#lib/search/flex/FlexProjector.js';
import { GroupedFlexGraph, type GroupedFlexChildRouteRequest } from '#lib/search/flex/GroupedFlexGraph.js';
import { FlexSnapshotBuilder, type FlexNativeCheckpoint } from '#lib/search/flex/FlexSnapshotBuilder.js';

interface GroupedFlexGraphRecord {
    readonly id: number;
    readonly graph: GroupedFlexGraph;
}

interface RankMergeCandidate {
    readonly level: number;
    readonly familyKey: string;
    readonly exactKey: string;
    readonly childLevel: number;
    readonly mass: bigint;
    readonly pool: SearchPool;
}

interface RankMergeCandidateGroup {
    readonly familyKey: string;
    readonly childLevel: number;
    readonly candidates: RankMergeCandidate[];
    readonly exactKeys: Set<string>;
    mass: bigint;
}

interface RankMergeRuntimeGroup {
    readonly profile: FlexPoolProfile;
}

interface RankMergeUsageStats {
    usedFamilyGroupCount: number;
    usedExactPoolCount: number;
    usedLevelCount: number;
    usedMass: bigint;
    fallbackFamilyGroupCount: number;
    fallbackExactPoolCount: number;
    fallbackLevelCount: number;
    fallbackMass: bigint;
}

const EMPTY_RANK_MERGE_STATS: FlexRankMergeMemoryStats = Object.freeze({
    eligibleFamilyGroupCount: 0,
    eligibleExactPoolCount: 0,
    eligibleLevelCount: 0,
    eligibleMass: 0n,
    usedFamilyGroupCount: 0,
    usedExactPoolCount: 0,
    usedLevelCount: 0,
    usedMass: 0n,
    fallbackFamilyGroupCount: 0,
    fallbackExactPoolCount: 0,
    fallbackLevelCount: 0,
    fallbackMass: 0n
});

export interface GroupedFlexSearchRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
    readonly targetClueId?: number | undefined;
    /**
     * Reduced mode merges by structural state; program mode conservatively keeps
     * distinct program histories separate for registries that fail the reduced-key invariant.
     */
    readonly stateIdentityMode?: FlexStateIdentityMode | undefined;
    readonly optimizationControls?: FlexOptimizationControls | undefined;
}

/**
 * Current Flex runner backed by grouped registry graphs.
 *
 * The `flex` name is retained for internal implementation modules and node types.
 */
export class GroupedFlexSearchRun {
    public readonly programs: FlexProgramStore;
    public readonly poolProfiles = new FlexPoolProfileStore();
    public readonly rankProfiles = this.poolProfiles;
    public readonly resultKeys = new FlexResultKeyStore();

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly graphsBySignature = new Map<string, GroupedFlexGraphRecord>();
    private readonly rankRuntimeGroups = new Map<string, RankMergeRuntimeGroup>();
    private readonly graphs: GroupedFlexGraph[] = [];
    private readonly coordinator = new FlexCoordinator(this.graphs, this.resultKeys);
    private readonly projector: FlexProjector;
    private readonly snapshotBuilder: FlexSnapshotBuilder;
    private readonly targetClueId: number | undefined;
    private readonly stateIdentityMode: FlexStateIdentityMode;
    private readonly optimizationControls: FlexOptimizationControls | undefined;
    private rankMergeStats: FlexRankMergeMemoryStats = EMPTY_RANK_MERGE_STATS;
    private seeded = false;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: GroupedFlexSearchRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
        this.targetClueId = options.targetClueId;
        this.optimizationControls = options.optimizationControls;
        this.stateIdentityMode = options.optimizationControls?.allowConflictMerge === false
            ? 'program'
            : options.stateIdentityMode ?? 'reduced';
        this.programs = new FlexProgramStore({
            canonicalizeProgramOrder: this.stateIdentityMode === 'program'
        });
        this.projector = new FlexProjector(this.programs, this.kernel.registry.enchantToIndex, {
            applyBookRemoval: this.kernel.item === 'book',
            targetClueId: this.targetClueId,
            poolProfiles: this.poolProfiles,
            resultKeys: this.resultKeys
        });
        this.snapshotBuilder = new FlexSnapshotBuilder(
            this.coordinator,
            this.projector,
            this.kernel.registry.indexToEnchant,
            (graphId, nodeId) => this.isTargetClueReachableById(graphId, nodeId)
        );
    }

    public seedXp(xp: number): void {
        if (this.seeded) throw new Error('GroupedFlexSearchRun can only be seeded once. Create a new run for a new cell.');
        this.seeded = true;

        const distribution = this.distributionService.getModifiedLevelDist(
            this.kernel.registry,
            xp,
            this.kernel.enchantability
        );

        let seededMass = 0n;
        const rankMergeCandidates: RankMergeCandidate[] = [];
        for (const [levelText, rootMass] of Object.entries(distribution)) {
            if (rootMass === 0n) continue;
            const level = Number(levelText);
            const pool = this.kernel.getPool(level);
            if (this.targetClueId !== undefined && !pool.entries.some(entry => entry.packedEnchant === this.targetClueId)) {
                this.coordinator.recordSeedClueIncompatible(rootMass);
                seededMass += rootMass;
                continue;
            }

            const childLevel = Math.floor(level / this.kernel.additionalEnchantmentLevelDivisor);
            rankMergeCandidates.push({
                level,
                familyKey: pool.familySignature,
                exactKey: pool.signature,
                childLevel,
                mass: rootMass,
                pool
            });
            seededMass += rootMass;
        }
        const usageStats = this.optimizationControls?.allowRankMerge === true && this.targetClueId === undefined
            ? this.seedRankMergedCandidates(rankMergeCandidates)
            : this.seedExactCandidates(rankMergeCandidates);
        this.rankMergeStats = createRankMergeStats(rankMergeCandidates, usageStats);

        if (seededMass < PRECISION) this.coordinator.recordSeedRounding(PRECISION - seededMass);
        if (seededMass > PRECISION) throw new Error(`Modified-level distribution overflowed precision by ${seededMass - PRECISION} units.`);
    }

    public searchToCheckpoint(request: FlexCheckpointRequest = {}): FlexRunSnapshot {
        return this.coordinator.searchToCheckpoint(request);
    }

    public searchToCheckpointState(request: FlexCheckpointRequest = {}): FlexRunState {
        return this.coordinator.searchToCheckpointState(request);
    }

    public searchToCheckpointAsync(request: FlexCheckpointRequest = {}): Promise<FlexRunSnapshot> {
        return this.coordinator.searchToCheckpointAsync(request);
    }

    public searchToCheckpointStateAsync(request: FlexCheckpointRequest = {}): Promise<FlexRunState> {
        return this.coordinator.searchToCheckpointStateAsync(request);
    }

    public snapshot(): FlexRunSnapshot {
        return this.coordinator.snapshot();
    }

    public state(): FlexRunState {
        return this.coordinator.state();
    }

    public getMemoryStats(): FlexRunMemoryStats {
        return {
            coordinator: this.coordinator.getMemoryStats(),
            programs: this.programs.getMemoryStats(),
            rankProfiles: this.poolProfiles.getMemoryStats(),
            graphs: this.graphs.map(graph => graph.getMemoryStats()),
            rankMerge: this.rankMergeStats
        };
    }

    public scanActiveResidueStatsForDiagnostics(): { readonly count: number; readonly mass: bigint } {
        return this.coordinator.scanActiveResidueStatsForDiagnostics();
    }

    public buildEngineSnapshot(state: FlexRunState = this.coordinator.state()): FlexNativeCheckpoint {
        return this.snapshotBuilder.build(state);
    }

    public getGraph(graphId: number): GroupedFlexGraph {
        const graph = this.graphs[graphId];
        if (!graph) throw new Error(`Unknown GroupedFlex graph ID ${graphId}.`);
        return graph;
    }

    private seedExactCandidates(candidates: readonly RankMergeCandidate[]): RankMergeUsageStats {
        for (const candidate of candidates) {
            this.seedExactCandidate(candidate);
        }
        return createEmptyRankMergeUsageStats();
    }

    private seedRankMergedCandidates(candidates: readonly RankMergeCandidate[]): RankMergeUsageStats {
        const usage = createEmptyRankMergeUsageStats();
        for (const group of groupRankMergeCandidates(candidates)) {
            if (group.exactKeys.size > 1) {
                const profile = this.rankProfiles.getOrCreate({
                    familyKey: group.familyKey,
                    childLevel: group.childLevel,
                    sources: group.candidates.map(candidate => ({
                        pool: candidate.pool,
                        level: candidate.level,
                        sourceMass: candidate.mass,
                        profileWeight: this.getPostFirstContinueProfileWeight(candidate)
                    }))
                });
                this.rankRuntimeGroups.set(createRankCandidateGroupKey(group.familyKey, group.childLevel), {
                    profile
                });
                addRankMergeUsage(usage, group, 'used');
            }
            for (const candidate of group.candidates) this.seedExactCandidate(candidate);
        }
        return usage;
    }

    private getPostFirstContinueProfileWeight(candidate: RankMergeCandidate): bigint {
        const probContinue = ProbUtils.PROB_CONTINUE_TABLE[candidate.level] ?? PRECISION;
        return ProbUtils.scale(candidate.mass, probContinue);
    }

    private seedExactCandidate(candidate: RankMergeCandidate): void {
        const graph = this.graphForPool(candidate.pool);
        const profile = this.poolProfiles.getOrCreateSingle(candidate.pool);
        const root = graph.graph.getRootNode(candidate.level, profile.id);
        this.coordinator.seedPending(graph.id, root.id, candidate.mass);
    }

    private graphForPool(pool: SearchPool): GroupedFlexGraphRecord {
        const key = this.optimizationControls?.allowRankMerge === true && this.targetClueId === undefined
            ? pool.familySignature
            : pool.signature;
        const existing = this.graphsBySignature.get(key);
        if (existing) return existing;

        const record = Object.freeze({
            id: this.graphs.length,
            graph: new GroupedFlexGraph(this.kernel, pool, this.programs, this.poolProfiles, {
                stateIdentityMode: this.stateIdentityMode,
                targetClueId: this.targetClueId,
                optimizationControls: this.optimizationControls,
                routeChild: this.optimizationControls?.allowRankMerge === true && this.targetClueId === undefined
                    ? request => this.routeRankMergedChild(request)
                    : undefined
            })
        });
        this.graphs.push(record.graph);
        this.graphsBySignature.set(key, record);
        return record;
    }

    private routeRankMergedChild(request: GroupedFlexChildRouteRequest): { readonly graphId: number; readonly nodeId: FlexNodeId } | undefined {
        if (request.childCount !== 2) return undefined;

        const group = this.rankRuntimeGroups.get(createRankCandidateGroupKey(request.pool.familySignature, request.childLevel));
        if (group === undefined) return undefined;

        const graph = this.graphForPool(request.pool);
        const node = graph.graph.getOrCreateRoutedNode(
            request.childExclusionMask,
            request.childLevel,
            request.childCount,
            request.childProgramId,
            group.profile.id
        );
        return {
            graphId: graph.id,
            nodeId: node.id
        };
    }

    private isTargetClueReachableById(graphId: number, nodeId: number): boolean | undefined {
        if (this.targetClueId === undefined) return undefined;
        const targetEnchantId = this.targetClueId >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        const targetBit = BIGINT_CONSTANTS.ID_BIT_LOOKUP[targetEnchantId];
        if (targetBit === undefined) return false;
        return (this.getGraph(graphId).getNodeExclusionMask(nodeId as FlexNodeId) & targetBit) === 0n;
    }
}

function createRankMergeStats(
    candidates: readonly RankMergeCandidate[],
    usage: RankMergeUsageStats
): FlexRankMergeMemoryStats {
    let eligibleFamilyGroupCount = 0;
    let eligibleExactPoolCount = 0;
    let eligibleLevelCount = 0;
    let eligibleMass = 0n;
    for (const group of groupRankMergeCandidates(candidates)) {
        if (group.exactKeys.size <= 1) continue;
        eligibleFamilyGroupCount++;
        eligibleExactPoolCount += group.exactKeys.size;
        eligibleLevelCount += group.candidates.length;
        eligibleMass += group.mass;
    }

    if (eligibleFamilyGroupCount === 0
        && usage.usedFamilyGroupCount === 0
        && usage.fallbackFamilyGroupCount === 0) {
        return EMPTY_RANK_MERGE_STATS;
    }

    return Object.freeze({
        eligibleFamilyGroupCount,
        eligibleExactPoolCount,
        eligibleLevelCount,
        eligibleMass,
        usedFamilyGroupCount: usage.usedFamilyGroupCount,
        usedExactPoolCount: usage.usedExactPoolCount,
        usedLevelCount: usage.usedLevelCount,
        usedMass: usage.usedMass,
        fallbackFamilyGroupCount: usage.fallbackFamilyGroupCount,
        fallbackExactPoolCount: usage.fallbackExactPoolCount,
        fallbackLevelCount: usage.fallbackLevelCount,
        fallbackMass: usage.fallbackMass
    });
}

function groupRankMergeCandidates(candidates: readonly RankMergeCandidate[]): RankMergeCandidateGroup[] {
    const groups = new Map<string, RankMergeCandidateGroup>();

    for (const candidate of candidates) {
        const key = createRankCandidateGroupKey(candidate.familyKey, candidate.childLevel);
        let group = groups.get(key);
        if (!group) {
            group = {
                familyKey: candidate.familyKey,
                childLevel: candidate.childLevel,
                candidates: [],
                exactKeys: new Set<string>(),
                mass: 0n
            };
            groups.set(key, group);
        }
        group.exactKeys.add(candidate.exactKey);
        group.candidates.push(candidate);
        group.mass += candidate.mass;
    }

    return [...groups.values()];
}

function createEmptyRankMergeUsageStats(): RankMergeUsageStats {
    return {
        usedFamilyGroupCount: 0,
        usedExactPoolCount: 0,
        usedLevelCount: 0,
        usedMass: 0n,
        fallbackFamilyGroupCount: 0,
        fallbackExactPoolCount: 0,
        fallbackLevelCount: 0,
        fallbackMass: 0n
    };
}

function addRankMergeUsage(
    usage: RankMergeUsageStats,
    group: RankMergeCandidateGroup,
    kind: 'used' | 'fallback'
): void {
    if (kind === 'used') {
        usage.usedFamilyGroupCount++;
        usage.usedExactPoolCount += group.exactKeys.size;
        usage.usedLevelCount += group.candidates.length;
        usage.usedMass += group.mass;
        return;
    }

    usage.fallbackFamilyGroupCount++;
    usage.fallbackExactPoolCount += group.exactKeys.size;
    usage.fallbackLevelCount += group.candidates.length;
    usage.fallbackMass += group.mass;
}

function createRankCandidateGroupKey(familySignature: string, childLevel: number): string {
    return `rank:${familySignature}:${String(childLevel)}`;
}
