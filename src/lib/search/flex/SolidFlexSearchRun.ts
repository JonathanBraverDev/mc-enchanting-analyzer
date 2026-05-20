import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchGraph } from '#lib/search/SearchGraph.js';
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
import { SolidFlexGraph } from '#lib/search/flex/SolidFlexGraph.js';

interface SolidFlexGraphRecord {
    readonly id: number;
    readonly graph: SolidFlexGraph;
}

export interface SolidFlexProjectedCheckpoint extends FlexProjectedResults {
    readonly pendingEntries: readonly FlexProjectedPendingEntry[];
    readonly projectedPendingMass: bigint;
}

export interface SolidFlexSearchRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
}

/**
 * Test-only bridge that runs Flex over concrete SearchGraph structure.
 *
 * This is intentionally not wired into SearchExecutionService. It proves that
 * Flex can reproduce concrete V7 shape before PlexNode grouping is introduced.
 */
export class SolidFlexSearchRun {
    public readonly programs = new FlexProgramStore();

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly graphsBySignature = new Map<SearchPoolSignature, SolidFlexGraphRecord>();
    private readonly graphs: SolidFlexGraph[] = [];
    private readonly coordinator = new FlexCoordinator(this.graphs);
    private readonly projector: FlexProjector;
    private seeded = false;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: SolidFlexSearchRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
        this.projector = new FlexProjector(this.programs, this.kernel.registry.enchantToIndex);
    }

    public seedXp(xp: number): void {
        if (this.seeded) throw new Error('SolidFlexSearchRun can only be seeded once. Create a new run for a new cell.');
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

    public projectSnapshot(snapshot: FlexRunSnapshot = this.snapshot()): SolidFlexProjectedCheckpoint {
        const projectedResults = this.projector.projectResults(snapshot.results);
        const pendingEntries = this.projector.projectPending(snapshot.pendingEntries);
        const projectedPendingMass = pendingEntries.reduce((sum, entry) => sum + entry.mass, 0n);

        return Object.freeze({
            ...projectedResults,
            pendingEntries,
            projectedPendingMass
        });
    }

    public getGraph(graphId: number): SolidFlexGraph {
        const graph = this.graphs[graphId];
        if (!graph) throw new Error(`Unknown SolidFlex graph ID ${graphId}.`);
        return graph;
    }

    private graphForPool(pool: SearchPool): SolidFlexGraphRecord {
        const existing = this.graphsBySignature.get(pool.signature);
        if (existing) return existing;

        const record = Object.freeze({
            id: this.graphs.length,
            graph: new SolidFlexGraph(
                new SearchGraph(this.kernel, pool),
                this.programs,
                this.kernel.registry.indexToEnchant
            )
        });
        this.graphs.push(record.graph);
        this.graphsBySignature.set(pool.signature, record);
        return record;
    }
}
