import { MassBookkeeping } from '#types/mass.js';
import { ExpansionBlueprint, PackedCombo, SearchState } from '#types/index.js';
import { PRECISION } from '#utils/index.js';

import { ProbabilityMassAccountant } from '#engine/search/ProbabilityMassAccountant.js';
import { SearchHeap } from '#utils/collections/SearchHeap.js';

interface ForwardingResidue {
    residue: bigint;
}

/**
 * Unified state accountant for probability mass and expanded node blueprints.
 * Facilitates high-speed forwarding through cached search subtrees.
 */
export class SearchStateTracker {
    public readonly mass: ProbabilityMassAccountant;
    private readonly expansionCache: Map<bigint, ExpansionBlueprint>;
    private readonly forwardingResidues: Map<bigint, ForwardingResidue>;

    constructor(
        initialMass?: MassBookkeeping,
        initialCache?: Map<bigint, ExpansionBlueprint>,
        initialResidues?: Map<bigint, ForwardingResidue>
    ) {
        this.mass = new ProbabilityMassAccountant(initialMass);
        this.expansionCache = initialCache || new Map();
        this.forwardingResidues = initialResidues || new Map();
    }

    /**
     * Initializes a new SearchState or clones an existing one.
     * Replaces the legacy StateFactory.
     */
    public static createState(
        modLevel: number,
        existing?: SearchState,
        threshold: bigint = 0n
    ): SearchState {
        if (existing) {
            return {
                queue: existing.queue.clone(),
                results: new Map(existing.results),
                tracker: existing.tracker.clone(),
                threshold,
                // iterations resets each run so SearchController can enforce per-run limits;
                // nodesProcessed is cumulative across all checkpoints and used for diagnostics only.
                iterations: 0,
                nodesProcessed: existing.nodesProcessed
            };
        }

        const results = new Map<PackedCombo, bigint>();
        const queue = new SearchHeap();

        // Always start from an empty generation state (0 packed, 0 bitset)
        const initialPacked = 0 as PackedCombo;
        const initialBitset = 0n;

        queue.pushOrMerge((initialBitset << 8n) | BigInt(modLevel), PRECISION, initialPacked);

        return {
            queue, results,
            tracker: new SearchStateTracker({
                resolved: 0n,
                pending: PRECISION,
                sieved: 0n,
                overflow: 0n,
                capped: 0n,
                rounding: 0n,
                recoveredRounding: 0n,
                recoveredSieved: 0n,
                clueKnownSpace: 0n
            }),
            threshold,
            iterations: 0,
            nodesProcessed: 0
        };
    }

    // --- Expansion Caching ---

    public registerExpansion(key: bigint, blueprint: ExpansionBlueprint): void {
        this.expansionCache.set(key, blueprint);
    }

    public has(key: bigint): boolean {
        return this.expansionCache.has(key);
    }

    public get(key: bigint): ExpansionBlueprint | undefined {
        return this.expansionCache.get(key);
    }

    public getCacheSize(): number {
        return this.expansionCache.size;
    }

    public getForwardingResidue(key: bigint): ForwardingResidue {
        let state = this.forwardingResidues.get(key);
        if (!state) {
            state = { residue: 0n };
            this.forwardingResidues.set(key, state);
        }
        return state;
    }

    public clone(): SearchStateTracker {
        const residues = new Map<bigint, ForwardingResidue>();
        for (const [key, value] of this.forwardingResidues) {
            residues.set(key, { residue: value.residue });
        }
        return new SearchStateTracker(this.mass.getBookkeeping(), new Map(this.expansionCache), residues);
    }
}
