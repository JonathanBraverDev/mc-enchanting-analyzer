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
import { RegistryFlexGraph } from '#lib/search/flex/RegistryFlexGraph.js';

interface RegistryFlexGraphRecord {
    readonly id: number;
    readonly graph: RegistryFlexGraph;
}

export interface RegistryFlexProjectedCheckpoint extends FlexProjectedResults {
    readonly pendingEntries: readonly FlexProjectedPendingEntry[];
    readonly projectedPendingMass: bigint;
    readonly projectedPendingSourceMass: bigint;
    readonly pendingProjectionLoss: bigint;
    readonly pendingClueIncompatible: bigint;
}

export interface RegistryFlexSearchRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
    readonly targetClueId?: number | undefined;
}

/**
 * Test-only Flex runner backed directly by registry-derived SolidNode graphs.
 *
 * This proves the Flex coordinator can reproduce V7 without using SearchGraph
 * as the structural implementation.
 */
export class RegistryFlexSearchRun {
    public readonly programs = new FlexProgramStore();

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly graphsBySignature = new Map<SearchPoolSignature, RegistryFlexGraphRecord>();
    private readonly graphs: RegistryFlexGraph[] = [];
    private readonly coordinator = new FlexCoordinator(this.graphs);
    private readonly projector: FlexProjector;
    private readonly targetClueId: number | undefined;
    private seeded = false;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: RegistryFlexSearchRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
        this.targetClueId = options.targetClueId;
        this.projector = new FlexProjector(this.programs, this.kernel.registry.enchantToIndex, {
            applyBookRemoval: this.kernel.item === 'book',
            targetClueId: this.targetClueId
        });
    }

    public seedXp(xp: number): void {
        if (this.seeded) throw new Error('RegistryFlexSearchRun can only be seeded once. Create a new run for a new cell.');
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

    public projectSnapshot(snapshot: FlexRunSnapshot = this.snapshot()): RegistryFlexProjectedCheckpoint {
        const projectedResults = this.projector.projectResults(snapshot.results);
        const projectedPending = this.projector.projectPendingWithDiagnostics(snapshot.pendingEntries);

        return Object.freeze({
            ...projectedResults,
            pendingEntries: projectedPending.pendingEntries,
            projectedPendingMass: projectedPending.projectedMass,
            projectedPendingSourceMass: projectedPending.sourceMass,
            pendingProjectionLoss: projectedPending.projectionLoss,
            pendingClueIncompatible: projectedPending.clueIncompatible
        });
    }

    public getGraph(graphId: number): RegistryFlexGraph {
        const graph = this.graphs[graphId];
        if (!graph) throw new Error(`Unknown RegistryFlex graph ID ${graphId}.`);
        return graph;
    }

    private graphForPool(pool: SearchPool): RegistryFlexGraphRecord {
        const existing = this.graphsBySignature.get(pool.signature);
        if (existing) return existing;

        const record = Object.freeze({
            id: this.graphs.length,
            graph: new RegistryFlexGraph(this.kernel, pool, this.programs)
        });
        this.graphs.push(record.graph);
        this.graphsBySignature.set(pool.signature, record);
        return record;
    }
}
