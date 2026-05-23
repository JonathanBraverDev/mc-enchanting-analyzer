import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { BIGINT_CONSTANTS, PACKING_CONSTANTS } from '#constants/engine.js';
import type { SearchPool, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { PRECISION } from '#utils/index.js';
import type {
    FlexCheckpointRequest,
    FlexPendingEntry,
    FlexProjectedPendingEntry,
    FlexProjectedResults,
    FlexRunSnapshot,
    FlexStateIdentityMode
} from '#lib/search/flex/FlexTypes.js';
import { FlexCoordinator } from '#lib/search/flex/FlexCoordinator.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';
import { FlexProjector } from '#lib/search/flex/FlexProjector.js';
import { GroupedFlexGraph } from '#lib/search/flex/GroupedFlexGraph.js';

interface GroupedFlexGraphRecord {
    readonly id: number;
    readonly graph: GroupedFlexGraph;
}

export interface GroupedFlexProjectedCheckpoint extends FlexProjectedResults {
    readonly pendingEntries: readonly FlexProjectedPendingEntry[];
    readonly projectedPendingMass: bigint;
    readonly projectedPendingSourceMass: bigint;
    readonly pendingProjectionLoss: bigint;
    readonly pendingClueIncompatible: bigint;
}

export interface GroupedFlexSearchRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
    readonly targetClueId?: number | undefined;
    readonly stateIdentityMode?: FlexStateIdentityMode | undefined;
}

/**
 * Flex runner backed by grouped registry graphs.
 *
 * This is the first PlexNode-capable Flex runner. It remains selected only by
 * explicit internal `searchBackend: 'flex'` requests while parity is being proven.
 */
export class GroupedFlexSearchRun {
    public readonly programs = new FlexProgramStore();

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly graphsBySignature = new Map<SearchPoolSignature, GroupedFlexGraphRecord>();
    private readonly graphs: GroupedFlexGraph[] = [];
    private readonly coordinator = new FlexCoordinator(this.graphs);
    private readonly projector: FlexProjector;
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
        this.projector = new FlexProjector(this.programs, this.kernel.registry.enchantToIndex, {
            applyBookRemoval: this.kernel.item === 'book',
            targetClueId: this.targetClueId
        });
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

    public searchToCheckpointAsync(request: FlexCheckpointRequest = {}): Promise<FlexRunSnapshot> {
        return this.coordinator.searchToCheckpointAsync(request);
    }

    public snapshot(): FlexRunSnapshot {
        return this.coordinator.snapshot();
    }

    public projectSnapshot(snapshot: FlexRunSnapshot = this.snapshot()): GroupedFlexProjectedCheckpoint {
        const projectedResults = this.projector.projectResults(snapshot.results);
        const projectedPending = this.projector.projectPendingWithDiagnostics(
            this.withPendingClueReachability(snapshot.pendingEntries)
        );

        return Object.freeze({
            ...projectedResults,
            pendingEntries: projectedPending.pendingEntries,
            projectedPendingMass: projectedPending.projectedMass,
            projectedPendingSourceMass: projectedPending.sourceMass,
            pendingProjectionLoss: projectedPending.projectionLoss,
            pendingClueIncompatible: projectedPending.clueIncompatible
        });
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

    private withPendingClueReachability(entries: readonly FlexPendingEntry[]): readonly FlexPendingEntry[] {
        if (this.targetClueId === undefined) return entries;

        return Object.freeze(entries.map(entry => Object.freeze({
            ...entry,
            targetClueReachable: this.isTargetClueReachable(entry)
        })));
    }

    private isTargetClueReachable(entry: FlexPendingEntry): boolean {
        if (this.targetClueId === undefined) return false;
        const targetEnchantId = this.targetClueId >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        const targetBit = BIGINT_CONSTANTS.ID_BIT_LOOKUP[targetEnchantId];
        if (targetBit === undefined) return false;
        return (this.getGraph(entry.graphId).getNodeExclusionMask(entry.nodeId) & targetBit) === 0n;
    }
}
