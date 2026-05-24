import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { BIGINT_CONSTANTS, PACKING_CONSTANTS } from '#constants/engine.js';
import type { SearchPool, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { PRECISION } from '#utils/index.js';
import type {
    FlexCheckpointRequest,
    FlexNodeId,
    FlexRunState,
    FlexRunSnapshot,
    FlexRunMemoryStats,
    FlexStateIdentityMode
} from '#lib/search/flex/FlexTypes.js';
import { FlexCoordinator } from '#lib/search/flex/FlexCoordinator.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';
import { FlexProjector } from '#lib/search/flex/FlexProjector.js';
import { GroupedFlexGraph } from '#lib/search/flex/GroupedFlexGraph.js';
import { FlexSnapshotBuilder, type FlexNativeCheckpoint, type FlexNativeSnapshotOptions } from '#lib/search/flex/FlexSnapshotBuilder.js';

interface GroupedFlexGraphRecord {
    readonly id: number;
    readonly graph: GroupedFlexGraph;
}

export interface GroupedFlexSearchRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
    readonly targetClueId?: number | undefined;
    /**
     * Reduced mode merges by structural state; program mode conservatively keeps
     * distinct program histories separate for registries that fail the reduced-key invariant.
     */
    readonly stateIdentityMode?: FlexStateIdentityMode | undefined;
}

/**
 * Flex runner backed by grouped registry graphs.
 *
 * This is the first PlexNode-capable Flex runner. It remains selected only by
 * explicit internal `searchBackend: 'flex'` requests while parity is being proven.
 */
export class GroupedFlexSearchRun {
    public readonly programs: FlexProgramStore;

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly graphsBySignature = new Map<SearchPoolSignature, GroupedFlexGraphRecord>();
    private readonly graphs: GroupedFlexGraph[] = [];
    private readonly coordinator = new FlexCoordinator(this.graphs);
    private readonly projector: FlexProjector;
    private readonly snapshotBuilder: FlexSnapshotBuilder;
    private readonly targetClueId: number | undefined;
    private readonly stateIdentityMode: FlexStateIdentityMode;
    private seeded = false;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: GroupedFlexSearchRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
        this.targetClueId = options.targetClueId;
        this.stateIdentityMode = options.stateIdentityMode ?? 'reduced';
        this.programs = new FlexProgramStore({
            canonicalizeProgramOrder: this.stateIdentityMode === 'program'
        });
        this.projector = new FlexProjector(this.programs, this.kernel.registry.enchantToIndex, {
            applyBookRemoval: this.kernel.item === 'book',
            targetClueId: this.targetClueId
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
        for (const [levelText, rootMass] of Object.entries(distribution)) {
            if (rootMass === 0n) continue;
            const level = Number(levelText);
            const pool = this.kernel.getPool(level);
            if (this.targetClueId !== undefined && !pool.entries.some(entry => entry.packedEnchant === this.targetClueId)) {
                this.coordinator.recordSeedClueIncompatible(rootMass);
                seededMass += rootMass;
                continue;
            }

            const graph = this.graphForPool(pool);
            const root = graph.graph.getRootNode(level);
            this.coordinator.seedPending(graph.id, root.id, rootMass);
            seededMass += rootMass;
        }

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
            graphs: this.graphs.map(graph => graph.getMemoryStats())
        };
    }

    public scanActiveResidueStatsForDiagnostics(): { readonly count: number; readonly mass: bigint } {
        return this.coordinator.scanActiveResidueStatsForDiagnostics();
    }

    public buildEngineSnapshot(
        state: FlexRunState = this.coordinator.state(),
        options: FlexNativeSnapshotOptions = {}
    ): FlexNativeCheckpoint {
        return this.snapshotBuilder.build(state, options);
    }

    public getGraph(graphId: number): GroupedFlexGraph {
        const graph = this.graphs[graphId];
        if (!graph) throw new Error(`Unknown GroupedFlex graph ID ${graphId}.`);
        return graph;
    }

    private graphForPool(pool: SearchPool): GroupedFlexGraphRecord {
        const existing = this.graphsBySignature.get(pool.signature);
        if (existing) return existing;

        const record = Object.freeze({
            id: this.graphs.length,
            graph: new GroupedFlexGraph(this.kernel, pool, this.programs, {
                stateIdentityMode: this.stateIdentityMode,
                targetClueId: this.targetClueId
            })
        });
        this.graphs.push(record.graph);
        this.graphsBySignature.set(pool.signature, record);
        return record;
    }

    private isTargetClueReachableById(graphId: number, nodeId: number): boolean | undefined {
        if (this.targetClueId === undefined) return undefined;
        const targetEnchantId = this.targetClueId >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        const targetBit = BIGINT_CONSTANTS.ID_BIT_LOOKUP[targetEnchantId];
        if (targetBit === undefined) return false;
        return (this.getGraph(graphId).getNodeExclusionMask(nodeId as FlexNodeId) & targetBit) === 0n;
    }
}
