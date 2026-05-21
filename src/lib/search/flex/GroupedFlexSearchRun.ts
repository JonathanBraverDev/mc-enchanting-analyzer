import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import type { SearchPool, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { PRECISION } from '#utils/index.js';
import type {
    FlexCheckpointRequest,
    FlexProjectedPendingEntry,
    FlexProjectedResults,
    FlexRunSnapshot
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
}

export interface GroupedFlexSearchRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
}

/**
 * Test-only Flex runner backed by grouped registry graphs.
 *
 * This is the first PlexNode-capable Flex runner, intentionally kept out of
 * SearchExecutionService while behavior parity is still being proven.
 */
export class GroupedFlexSearchRun {
    public readonly programs = new FlexProgramStore();

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly graphsBySignature = new Map<SearchPoolSignature, GroupedFlexGraphRecord>();
    private readonly graphs: GroupedFlexGraph[] = [];
    private readonly coordinator = new FlexCoordinator(this.graphs);
    private readonly projector: FlexProjector;
    private seeded = false;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: GroupedFlexSearchRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
        this.projector = new FlexProjector(this.programs, this.kernel.registry.enchantToIndex, {
            applyBookRemoval: this.kernel.item === 'book'
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
            const graph = this.graphForPool(this.kernel.getPool(level));
            const root = graph.graph.getRootNode(level);
            this.coordinator.seedPending(graph.id, root.id, rootMass);
            seededMass += rootMass;
        }

        if (seededMass < PRECISION) this.coordinator.mass.record('rounding', PRECISION - seededMass);
        if (seededMass > PRECISION) throw new Error(`Modified-level distribution overflowed precision by ${seededMass - PRECISION} units.`);
    }

    public searchToCheckpoint(request: FlexCheckpointRequest = {}): FlexRunSnapshot {
        return this.coordinator.searchToCheckpoint(request);
    }

    public snapshot(): FlexRunSnapshot {
        return this.coordinator.snapshot();
    }

    public projectSnapshot(snapshot: FlexRunSnapshot = this.snapshot()): GroupedFlexProjectedCheckpoint {
        const projectedResults = this.projector.projectResults(snapshot.results);
        const pendingEntries = this.projector.projectPending(snapshot.pendingEntries);
        const projectedPendingMass = pendingEntries.reduce((sum, entry) => sum + entry.mass, 0n);

        return Object.freeze({
            ...projectedResults,
            pendingEntries,
            projectedPendingMass
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
            graph: new GroupedFlexGraph(this.kernel, pool, this.programs)
        });
        this.graphs.push(record.graph);
        this.graphsBySignature.set(pool.signature, record);
        return record;
    }
}
