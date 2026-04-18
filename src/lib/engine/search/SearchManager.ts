import { MassBookkeeping, MassAccounting, MassEventType } from '#types/mass.js';
import { ExpansionBlueprint, ForwardingContext, PackedCombo } from '#types/index.js';
import { ProbUtils, ComboUtils, PRECISION } from '#utils/index.js';

import { DistributionPool } from '#engine/distribution/DistributionPool.js';
import { ENGINE_LIMITS, PACKING_CONSTANTS, SEARCH_CONSTANTS } from '#constants/engine.js';

/**
 * Unified state tracker for probability mass and expanded node blueprints.
 * Facilitates high-speed forwarding through cached search subtrees.
 */
export class SearchManager {
    private static readonly MAX_RECURSION_DEPTH = SEARCH_CONSTANTS.MAX_RECURSION_DEPTH;
    
    /** Scratch stacks for synchronous tree forwarding to avoid per-node allocations. */
    private static readonly STACK_MASS = new BigUint64Array(1024);
    private static readonly STACK_META = new BigUint64Array(1024);
    private static readonly STACK_DEPTH = new Int32Array(1024);
    private static STACK_PTR = 0;
    
    private readonly buckets: Record<MassEventType, bigint>;
    private readonly expansionCache: Map<bigint, ExpansionBlueprint>;

    constructor(initialBuckets?: MassBookkeeping, initialCache?: Map<bigint, ExpansionBlueprint>) {
        this.buckets = initialBuckets ? { ...initialBuckets } : {
            resolved: 0n,
            pending: 0n,
            sieved: 0n,
            overflow: 0n,
            capped: 0n,
            rounding: 0n,
            recoveredRounding: 0n,
            recoveredSieved: 0n
        };
        this.expansionCache = initialCache || new Map();
    }

    public record(type: MassEventType, prob: bigint): void {
        this.buckets[type] += prob;
    }

    public subtract(type: MassEventType, prob: bigint): void {
        this.buckets[type] -= prob;
    }

    public addScaled(other: SearchManager, factor: bigint): void {
        const b = this.buckets;
        const o = other.buckets;
        b.resolved += ProbUtils.scale(o.resolved, factor);
        b.pending += ProbUtils.scale(o.pending, factor);
        b.sieved += ProbUtils.scale(o.sieved, factor);
        b.overflow += ProbUtils.scale(o.overflow, factor);
        b.capped += ProbUtils.scale(o.capped, factor);
        b.rounding += ProbUtils.scale(o.rounding, factor);
        b.recoveredRounding += ProbUtils.scale(o.recoveredRounding, factor);
        b.recoveredSieved += ProbUtils.scale(o.recoveredSieved, factor);
    }

    public getTotalMass(): bigint {
        const b = this.buckets;
        return b.resolved + b.pending + b.sieved + b.overflow + b.capped + b.rounding;
    }

    public getBookkeeping(): MassBookkeeping {
        return { ...this.buckets };
    }

    public toPublic(): MassAccounting {
        const b = this.buckets;
        return {
            resolved: ProbUtils.toNumber(b.resolved),
            pending: ProbUtils.toNumber(b.pending),
            sieved: ProbUtils.toNumber(b.sieved),
            overflow: ProbUtils.toNumber(b.overflow),
            capped: ProbUtils.toNumber(b.capped),
            rounding: ProbUtils.toNumber(b.rounding),
            recoveredRounding: ProbUtils.toNumber(b.recoveredRounding),
            recoveredSieved: ProbUtils.toNumber(b.recoveredSieved),
            units: {
                resolved: b.resolved.toString(),
                pending: b.pending.toString(),
                sieved: b.sieved.toString(),
                overflow: b.overflow.toString(),
                capped: b.capped.toString(),
                rounding: b.rounding.toString(),
                recoveredRounding: b.recoveredRounding.toString(),
                recoveredSieved: b.recoveredSieved.toString()
            }
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

    // --- Mass Forwarding ---

    /**
     * Forwards probability mass to cached children, bypassing the priority queue.
     * Uses an iterative stack-based approach to maintain linear memory flow.
     */
    public forwardMass(
        initialMass: bigint,
        initialMeta: bigint,
        ctx: ForwardingContext,
        searchProcessor: {
            settleMass: (...args: any[]) => bigint;
        }
    ): bigint {
        SearchManager.STACK_PTR = 0;
        const ptr = SearchManager.STACK_PTR++;
        SearchManager.STACK_MASS[ptr] = initialMass;
        SearchManager.STACK_META[ptr] = initialMeta;
        SearchManager.STACK_DEPTH[ptr] = 0;

        let totalResolvedFromTrees = 0n;

        while (SearchManager.STACK_PTR > 0) {
            const currentPtr = --SearchManager.STACK_PTR;
            const incomingMass = SearchManager.STACK_MASS[currentPtr]!;
            const meta = SearchManager.STACK_META[currentPtr]!;
            const depth = SearchManager.STACK_DEPTH[currentPtr]!;
            
            const blueprint = this.expansionCache.get(meta);
            if (!blueprint) continue;

            const { registry, cat, guaranteedFirstId, resultsLimit } = ctx;
            
            // Split mass into stop vs forward
            const probContinue = blueprint.probContinue;
            const probStop = ProbUtils.scale(incomingMass, (PRECISION - probContinue));
            const probForward = ProbUtils.scale(incomingMass, probContinue);
            const scaleLoss = incomingMass - (probStop + probForward);

            const isBook = cat === "book";
            const currentCount = blueprint.currentCount;
            const currentCombo = blueprint.currentCombo;
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
            const isTooSmall = probForward < ENGINE_LIMITS.SYSTEM_THRESHOLD_UNIT;
            const isMapFull = ctx.results.size >= resultsLimit && !ctx.results.has(currentCombo);
            
            if (isLimitReached || isTooSmall || isMapFull || blueprint.totalWeight === 0) {
                totalResolvedFromTrees += this.handleTerminal(
                    incomingMass, probStop, probForward, remStop, scaleLoss, blueprint, 
                    { isLimitReached, isTooSmall, isMapFull }, ctx, searchProcessor
                );
                continue;
            }

            // Standard expansion path
            const resolvedSub = this.processExpansionStep(probStop, probForward, remStop, scaleLoss, 
                meta >> BigInt(PACKING_CONSTANTS.ENCHANT_SHIFT), 
                blueprint, ctx, depth);
            totalResolvedFromTrees += resolvedSub;
        }

        return totalResolvedFromTrees;
    }

    private handleTerminal(
        _incomingMass: bigint,
        probStop: bigint,
        probForward: bigint,
        remStop: bigint,
        scaleLoss: bigint,
        blueprint: ExpansionBlueprint,
        term: { isLimitReached: boolean; isTooSmall: boolean; isMapFull: boolean },
        ctx: ForwardingContext,
        searchProcessor: {
            settleMass: (...args: any[]) => bigint;
        }
    ): bigint {
        const { registry, cat, guaranteedFirstId, instrumentation } = ctx;
        
        let remForward = 0n;
        const isBook = cat === "book";
        
        if (isBook && blueprint.currentCount > 1) {
            remForward = searchProcessor.settleMass(
                true, blueprint.currentCount, blueprint.currentCombo, 
                probForward, guaranteedFirstId, registry.enchantToIndex, registry.indexToEnchant, 
                ctx.results, ctx.countMass, ctx.anyMass, ctx.rankMass
            );
        } else {
            ProbUtils.addItemMass(ctx.results, blueprint.currentCombo, probForward);
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
        return (probStop - remStop) + (blueprint.totalWeight === 0 ? (probForward - remForward) : 0n);
    }

    private processExpansionStep(
        probStop: bigint,
        probForward: bigint,
        remStop: bigint,
        scaleLoss: bigint,
        currentBitset: bigint,
        blueprint: ExpansionBlueprint,
        ctx: ForwardingContext,
        depth: number
    ): bigint {
        const { registry, instrumentation, queue, guaranteedFirstId } = ctx;

        const eligibleCount = blueprint.eligibleCount;
        const splits = DistributionPool.getBuffer(depth);

        this.buckets.rounding += (probForward % BigInt(blueprint.totalWeight));
        const { recovered } = ProbUtils.distributeWithResidue(
            probForward, blueprint.eligibleWeights, blueprint.totalWeight, splits, blueprint, eligibleCount
        );
        if (recovered > 0n) {
            this.buckets.rounding -= recovered;
            this.buckets.recoveredRounding += recovered;
            if (instrumentation) instrumentation.roundingErrorEvents++;
        }

        const guaranteedInCombo = guaranteedFirstId != null && (currentBitset & (1n << BigInt(guaranteedFirstId))) !== 0n;

        for (const [i, e] of blueprint.eligibleEnchants.entries()) {
            if (i >= eligibleCount) break;
            const pNext = splits[i];
            if (pNext === undefined || pNext === 0n) continue;

            const nextPacked = ComboUtils.packAppend(blueprint.currentCombo, e, guaranteedFirstId, guaranteedInCombo, registry.enchantToIndex) as PackedCombo;
            const nextId = ComboUtils.getEnchantId(e);
            const nextMeta = ((currentBitset | (1n << BigInt(nextId))) << BigInt(PACKING_CONSTANTS.ENCHANT_SHIFT)) | BigInt(blueprint.nextLevel);

            ctx.anyMass[nextId]! += pNext;
            ctx.rankMass[e]! += pNext;

            if (this.expansionCache.has(nextMeta) && depth < SearchManager.MAX_RECURSION_DEPTH) {
                const nextPtr = SearchManager.STACK_PTR++;
                SearchManager.STACK_MASS[nextPtr] = pNext;
                SearchManager.STACK_META[nextPtr] = nextMeta;
                SearchManager.STACK_DEPTH[nextPtr] = depth + 1;
            } else {
                this.buckets.pending += pNext;
                queue.pushOrMerge(nextMeta, pNext, blueprint.nextLevel, nextPacked);
            }
        }

        this.buckets.resolved += (probStop - remStop);
        this.buckets.rounding += (remStop + scaleLoss);
        
        return (probStop - remStop);
    }

    public clone(): SearchManager {
        return new SearchManager(this.getBookkeeping(), new Map(this.expansionCache));
    }
}
