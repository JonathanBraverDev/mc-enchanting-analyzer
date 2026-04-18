import { ExpansionBlueprint, ForwardingContext, MassBookkeeping, PackedCombo } from '#types/index.js';
import { DistributionPool } from '#engine/distribution/DistributionPool.js';
import { PRECISION, ProbUtils, ComboUtils } from '#utils/index.js';
import { PACKING_CONSTANTS, ENGINE_LIMITS, BIGINT_CONSTANTS } from '#constants/engine.js';

/**
 * Manages probability mass tracking and iterative expansion.
 * Acts as the "Accountant" for the search engine, ensuring mass conservation.
 */
export class SearchManager {
    private static STACK_PTR = 0;
    private static readonly STACK_MASS = new BigUint64Array(1024);
    private static readonly STACK_META = new BigUint64Array(1024);
    private static readonly STACK_COMBO = new Float64Array(1024); // Use Float64 for bit-safe storage of PackedCombo (number)
    private static readonly STACK_DEPTH = new Int32Array(1024);

    private visited = new Set<bigint>();
    private residues = new Map<bigint, bigint>();
    private expansionCache = new Map<bigint, ExpansionBlueprint>(); // Reverted to search-local cache for safety and isolation
    private buckets: MassBookkeeping;

    constructor(initialBuckets?: MassBookkeeping) {
        this.buckets = initialBuckets ?? {
            resolved: 0n,
            pending: 0n,
            sieved: 0n,
            overflow: 0n,
            capped: 0n,
            rounding: 0n,
            recoveredRounding: 0n,
            recoveredSieved: 0n
        };
    }

    public record(bucket: keyof MassBookkeeping, mass: bigint): void {
        this.buckets[bucket] += mass;
    }

    public subtract(bucket: keyof MassBookkeeping, mass: bigint): void {
        this.buckets[bucket] -= mass;
    }

    public has(key: bigint): boolean {
        return this.visited.has(key);
    }

    public hasBlueprint(key: bigint): boolean {
        return this.expansionCache.has(key);
    }

    public getBlueprint(key: bigint): ExpansionBlueprint | undefined {
        return this.expansionCache.get(key);
    }

    public setBlueprint(key: bigint, blueprint: ExpansionBlueprint): void {
        this.expansionCache.set(key, blueprint);
    }

    public markVisited(key: bigint): void {
        this.visited.add(key);
    }

    public getCacheSize(): number {
        return this.visited.size;
    }

    // --- Mass Forwarding ---

    /**
     * Forwards probability mass to cached children, bypassing the priority queue.
     * Uses an iterative stack-based approach to maintain linear memory flow.
     */
    public forwardMass(
        initialMass: bigint,
        initialMeta: bigint,
        initialCombo: PackedCombo,
        ctx: ForwardingContext,
        searchProcessor: {
            settleMass: (...args: any[]) => bigint;
        }
    ): void {
        const { registry, cat, guaranteedFirstId, resultsLimit } = ctx;

        SearchManager.STACK_PTR = 0;
        const ptr = SearchManager.STACK_PTR++;
        SearchManager.STACK_MASS[ptr] = initialMass;
        SearchManager.STACK_META[ptr] = initialMeta;
        SearchManager.STACK_COMBO[ptr] = initialCombo;
        SearchManager.STACK_DEPTH[ptr] = 0;

        while (SearchManager.STACK_PTR > 0) {
            const currentPtr = --SearchManager.STACK_PTR;
            const incomingMass = SearchManager.STACK_MASS[currentPtr]!;
            const meta = SearchManager.STACK_META[currentPtr]!;
            const combo = SearchManager.STACK_COMBO[currentPtr]! as any as PackedCombo;
            const depth = SearchManager.STACK_DEPTH[currentPtr]!;
            
            const blueprint = this.expansionCache.get(meta);
            if (!blueprint) continue;

            // Split mass into stop vs forward
            const probContinue = blueprint.probContinue;
            const probStop = ProbUtils.scale(incomingMass, (PRECISION - probContinue));
            const probForward = ProbUtils.scale(incomingMass, probContinue);
            const scaleLoss = incomingMass - (probStop + probForward);

            const isBook = cat === "book";
            const currentCount = blueprint.currentCount;
            const currentCombo = combo;
            let remStop = 0n;

            if (isBook && currentCount > 1) {
                remStop = searchProcessor.settleMass(
                    true, currentCount, currentCombo,
                    probStop, guaranteedFirstId, registry.enchantToIndex, registry.indexToEnchant,
                    ctx.results, ctx.countMass, ctx.anyMass, ctx.rankMass
                );
            } else {
                ProbUtils.addItemMass(ctx.results, currentCombo, probStop);
                ctx.countMass[currentCount]! += probStop;
            }

            // Terminal Check
            const isLimitReached = currentCount >= (isBook && !registry.multiEnchantBooks ? 1 : ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM);
            const isTooSmall = probForward < (ctx.threshold || ENGINE_LIMITS.SYSTEM_THRESHOLD_UNIT);
            const isMapFull = ctx.results.size >= resultsLimit && !ctx.results.has(currentCombo);
            
            if (isLimitReached || isTooSmall || isMapFull || blueprint.totalWeight === 0) {
                this.handleTerminal(
                    incomingMass, probStop, probForward, remStop, scaleLoss, currentCombo, blueprint, 
                    { isLimitReached, isTooSmall, isMapFull }, ctx, searchProcessor
                );
                continue;
            }

            // Standard expansion path
            this.processExpansionStep(probStop, probForward, remStop, scaleLoss, currentCombo,
                meta, 
                blueprint, ctx, depth);
        }
    }

    private handleTerminal(
        _incomingMass: bigint,
        probStop: bigint,
        probForward: bigint,
        remStop: bigint,
        scaleLoss: bigint,
        currentCombo: PackedCombo,
        blueprint: ExpansionBlueprint,
        term: { isLimitReached: boolean; isTooSmall: boolean; isMapFull: boolean },
        ctx: ForwardingContext,
        searchProcessor: {
            settleMass: (...args: any[]) => bigint;
        }
    ): void {
        const { registry, cat, guaranteedFirstId, instrumentation } = ctx;
        
        let remForward = 0n;
        const isBook = cat === "book";
        
        if (isBook && blueprint.currentCount > 1) {
            remForward = searchProcessor.settleMass(
                true, blueprint.currentCount, currentCombo, 
                probForward, guaranteedFirstId, registry.enchantToIndex, registry.indexToEnchant, 
                ctx.results, ctx.countMass, ctx.anyMass, ctx.rankMass
            );
        } else {
            ProbUtils.addItemMass(ctx.results, currentCombo, probForward);
            ctx.countMass[blueprint.currentCount]! += probForward;
        }

        const localRounding = remStop + remForward + scaleLoss;
        
        this.buckets.resolved += (probStop - remStop);
        this.buckets.rounding += localRounding;
        
        if (term.isTooSmall) {
            if (instrumentation) instrumentation.totalPrunedNodes++;
            this.buckets.sieved += (probForward - remForward);
        } else if (term.isLimitReached) {
            this.buckets.overflow += (probForward - remForward);
        } else if (term.isMapFull) {
            this.buckets.capped += (probForward - remForward);
        } else if (blueprint.totalWeight === 0) {
            this.buckets.resolved += (probForward - remForward);
        }

        if (localRounding > 0n && instrumentation) instrumentation.roundingErrorEvents++;
    }

    private processExpansionStep(
        probStop: bigint,
        probForward: bigint,
        remStop: bigint,
        scaleLoss: bigint,
        currentCombo: PackedCombo,
        meta: bigint,
        blueprint: ExpansionBlueprint,
        ctx: ForwardingContext,
        depth: number
    ): void {
        const { registry, queue, guaranteedFirstId } = ctx;

        const eligibleCount = blueprint.eligibleCount;
        const splits = DistributionPool.getBuffer(depth);
        
        const oldResidue = this.residues.get(meta) || 0n;
        const { recovered, newResidue } = ProbUtils.distributeWithResidue(
            probForward, blueprint.eligibleWeights, blueprint.totalWeight, splits, oldResidue, eligibleCount
        );
        this.residues.set(meta, newResidue);

        this.buckets.rounding += (remStop + (newResidue - oldResidue) + scaleLoss);
        this.buckets.resolved += (probStop - remStop);
        this.buckets.recoveredRounding += recovered;
        
        const eligibleEnchants = blueprint.eligibleEnchants;
        const currentBitset = meta >> BIGINT_CONSTANTS.ENCHANT_SHIFT;

        for (let i = 0; i < eligibleCount; i++) {
            const pNext = splits[i]!;
            if (pNext === 0n) continue;

            const nextItem = eligibleEnchants[i]!;
            const nextId = nextItem >> PACKING_CONSTANTS.ENCHANT_SHIFT;
            const nextMeta = ((currentBitset | BIGINT_CONSTANTS.ID_BIT_LOOKUP[nextId]!) << BIGINT_CONSTANTS.ENCHANT_SHIFT) | BIGINT_CONSTANTS.LEVEL_LOOKUP[blueprint.nextLevel]!;
            
            const guaranteedIdLookup = guaranteedFirstId === null ? 0n : (BIGINT_CONSTANTS.ID_BIT_LOOKUP[guaranteedFirstId] ?? 0n);
            const nextPacked = ComboUtils.packAppend(
                currentCombo, nextItem, guaranteedFirstId, (currentBitset & guaranteedIdLookup) !== 0n, registry.enchantToIndex
            ) as PackedCombo;

            ctx.anyMass[nextId]! += pNext;
            ctx.rankMass[nextItem]! += pNext;

            if (this.has(nextMeta)) {
                // Iterative forward via stack
                if (SearchManager.STACK_PTR < SearchManager.STACK_MASS.length) {
                    const ptr = SearchManager.STACK_PTR++;
                    SearchManager.STACK_MASS[ptr] = pNext;
                    SearchManager.STACK_META[ptr] = nextMeta;
                    SearchManager.STACK_COMBO[ptr] = nextPacked;
                    SearchManager.STACK_DEPTH[ptr] = depth + 1;
                } else {
                    // Safety valve
                    queue.pushOrMerge(nextMeta, pNext, blueprint.nextLevel, nextPacked);
                    this.buckets.pending += pNext;
                }
            } else {
                queue.pushOrMerge(nextMeta, pNext, blueprint.nextLevel, nextPacked);
                this.buckets.pending += pNext;
            }
        }
    }

    public getTotalMass(): bigint {
        return this.buckets.resolved + 
               this.buckets.pending + 
               this.buckets.sieved + 
               this.buckets.overflow + 
               this.buckets.capped + 
               this.buckets.rounding;
    }

    public addScaled(other: SearchManager, factor: bigint): void {
        const otherBk = other.buckets;
        this.buckets.resolved += ProbUtils.scale(otherBk.resolved, factor);
        this.buckets.pending += ProbUtils.scale(otherBk.pending, factor);
        this.buckets.sieved += ProbUtils.scale(otherBk.sieved, factor);
        this.buckets.overflow += ProbUtils.scale(otherBk.overflow, factor);
        this.buckets.capped += ProbUtils.scale(otherBk.capped, factor);
        this.buckets.rounding += ProbUtils.scale(otherBk.rounding, factor);
        this.buckets.recoveredRounding += ProbUtils.scale(otherBk.recoveredRounding, factor);
        this.buckets.recoveredSieved += ProbUtils.scale(otherBk.recoveredSieved, factor);
    }

    public getBookkeeping(): MassBookkeeping {
        return { ...this.buckets };
    }

    public toPublic(): { resolved: number, pending: number, sieved: number, rounding: number, overflow: number, capped: number, recoveredRounding: number, recoveredSieved: number, units: Record<string, string> } {
        const factor = Number(PRECISION);
        return {
            resolved: Number(this.buckets.resolved) / factor,
            pending: Number(this.buckets.pending) / factor,
            sieved: Number(this.buckets.sieved) / factor,
            rounding: Number(this.buckets.rounding) / factor,
            overflow: Number(this.buckets.overflow) / factor,
            capped: Number(this.buckets.capped) / factor,
            recoveredRounding: Number(this.buckets.recoveredRounding) / factor,
            recoveredSieved: Number(this.buckets.recoveredSieved) / factor,
            units: {
                resolved: this.buckets.resolved.toString(),
                pending: this.buckets.pending.toString(),
                sieved: this.buckets.sieved.toString(),
                overflow: this.buckets.overflow.toString(),
                capped: this.buckets.capped.toString(),
                rounding: this.buckets.rounding.toString(),
                recoveredRounding: this.buckets.recoveredRounding.toString(),
                recoveredSieved: this.buckets.recoveredSieved.toString()
            }
        };
    }

    public clone(): SearchManager {
        const other = new SearchManager({ ...this.buckets });
        other.visited = new Set(this.visited);
        other.residues = new Map(this.residues);
        other.expansionCache = new Map(this.expansionCache);
        return other;
    }
}
