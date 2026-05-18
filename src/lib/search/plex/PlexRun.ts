import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { ProbabilityMassAccountant } from '#engine/search/ProbabilityMassAccountant.js';
import type { MassAccountingBreakdown } from '#types/mass.js';
import { PRECISION } from '#utils/index.js';
import type { SearchPool, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import { RegistryKernel } from '#lib/search/registry/RegistryKernel.js';
import { PlexGraph, type PlexNodeId } from '#lib/search/plex/PlexGraph.js';
import {
    EMPTY_PLEX_PAYLOAD,
    type PlexPayload
} from '#lib/search/plex/PlexPayload.js';

export interface PlexRunOptions {
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
}

export interface PlexPendingEntry {
    readonly graphId: number;
    readonly nodeId: PlexNodeId;
    readonly mass: bigint;
    readonly payload: PlexPayload;
    readonly count: number;
    readonly currentLevel: number;
}

export interface PlexRunSnapshot {
    readonly mass: MassAccountingBreakdown;
    readonly pendingCount: number;
    readonly largestPendingMass: bigint;
    readonly pendingEntries: readonly PlexPendingEntry[];
    readonly graphCount: number;
    readonly seededLevelCount: number;
    readonly fullyResolved: boolean;
}

interface PlexGraphRecord {
    readonly id: number;
    readonly graph: PlexGraph;
}

interface PendingPlexWork {
    readonly graphId: number;
    readonly nodeId: PlexNodeId;
    readonly mass: bigint;
    readonly payload: PlexPayload;
}

/**
 * Minimal opt-in executor shell for plex search experiments.
 *
 * This intentionally does not replace `SearchRun`. The first slice only seeds
 * modified-level mass into plex structural graphs with explicit payloads so the
 * frontier shape can be tested before forwarding, residue, and result accounting
 * are introduced.
 */
export class PlexRun {
    public readonly mass = new ProbabilityMassAccountant();

    private readonly distributionService: ModifiedLevelDistributionService;
    private readonly graphsBySignature = new Map<SearchPoolSignature, PlexGraphRecord>();
    private readonly graphs: PlexGraphRecord[] = [];
    private readonly pending: PendingPlexWork[] = [];
    private seeded = false;
    private _seededLevelCount = 0;

    public constructor(
        private readonly kernel: RegistryKernel,
        options: PlexRunOptions = {}
    ) {
        this.distributionService = options.distributionService ?? new ModifiedLevelDistributionService();
    }

    public seedXp(xp: number): void {
        if (this.seeded) throw new Error('PlexRun can only be seeded once. Create a new run for a new cell.');
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
            const graph = this.graphForPool(pool);
            const root = graph.graph.getRootNode(level);

            this.pushPending(graph.id, root.id, rootMass, EMPTY_PLEX_PAYLOAD);
            seededMass += rootMass;
            this._seededLevelCount++;
        }

        if (seededMass < PRECISION) this.mass.record('rounding', PRECISION - seededMass);
        if (seededMass > PRECISION) throw new Error(`Modified-level distribution overflowed precision by ${seededMass - PRECISION} units.`);
    }

    public snapshot(): PlexRunSnapshot {
        return Object.freeze({
            mass: this.mass.toPublic(),
            pendingCount: this.pending.length,
            largestPendingMass: this.pending.reduce((largest, entry) => entry.mass > largest ? entry.mass : largest, 0n),
            pendingEntries: Object.freeze(this.getPendingEntries()),
            graphCount: this.graphs.length,
            seededLevelCount: this._seededLevelCount,
            fullyResolved: this.pending.length === 0
        });
    }

    public getGraph(graphId: number): PlexGraph {
        return this.getGraphById(graphId).graph;
    }

    private pushPending(graphId: number, nodeId: PlexNodeId, mass: bigint, payload: PlexPayload): void {
        if (mass === 0n) return;
        this.pending.push(Object.freeze({ graphId, nodeId, mass, payload }));
        this.mass.record('pending', mass);
    }

    private getPendingEntries(): PlexPendingEntry[] {
        return this.pending.map(entry => {
            const node = this.getGraphById(entry.graphId).graph.getNode(entry.nodeId);
            return Object.freeze({
                graphId: entry.graphId,
                nodeId: entry.nodeId,
                mass: entry.mass,
                payload: entry.payload,
                count: node.count,
                currentLevel: node.currentLevel
            });
        });
    }

    private graphForPool(pool: SearchPool): PlexGraphRecord {
        const existing = this.graphsBySignature.get(pool.signature);
        if (existing) return existing;

        const record = Object.freeze({
            id: this.graphs.length,
            graph: new PlexGraph(this.kernel, pool)
        });
        this.graphs.push(record);
        this.graphsBySignature.set(pool.signature, record);
        return record;
    }

    private getGraphById(graphId: number): PlexGraphRecord {
        const record = this.graphs[graphId];
        if (!record) throw new Error(`Unknown plex graph ID ${graphId}`);
        return record;
    }
}
