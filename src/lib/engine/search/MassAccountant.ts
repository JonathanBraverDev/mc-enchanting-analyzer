import { MassBookkeeping, MassAccounting, MassEventType } from '#types/mass.js';
import { ExpansionBlueprint, RegistryState, ForwardingContext, PackedCombo, PackedEnchant } from '#types/index.js';
import { ProbUtils, ComboUtils, PRECISION } from '#utils/index.js';
import { ENGINE_LIMITS, SEARCH_CONSTANTS } from '#constants/engine.js';
import { DistributionPool } from '#engine/distribution.js';
import { MassAccountant } from './MassBuckets.js';

/**
 * Unified state tracker for probability mass and expanded node blueprints.
 * Facilitates high-speed forwarding through cached search subtrees.
 */
export class ProbabilityMassTracker {
    private static readonly MAX_RECURSION_DEPTH = 10;
    
    private readonly accountant: MassAccountant;
    private readonly expansionCache: Map<bigint, ExpansionBlueprint>;

    constructor(initialMass?: MassBookkeeping, initialCache?: Map<bigint, ExpansionBlueprint>) {
        this.accountant = new MassAccountant(initialMass);
        this.expansionCache = initialCache || new Map();
    }

    public record(type: MassEventType, prob: bigint): void {
        this.accountant.record(type, prob);
    }

    public subtract(type: MassEventType, prob: bigint): void {
        this.accountant.subtract(type, prob);
    }

    public addScaled(other: ProbabilityMassTracker, factor: bigint): void {
        this.accountant.addScaled(other.accountant, factor);
    }

    public getTotalMass(): bigint {
        return this.accountant.getTotalMass();
    }

    public getBookkeeping(): MassBookkeeping {
        return this.accountant.getBookkeeping();
    }

    public toPublic(): MassAccounting {
        return this.accountant.toPublic();
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
        initialCombo: PackedCombo,
        ctx: ForwardingContext,
        searchProcessor: {
            withTiming: <T>(timing: any, bucket: any, fn: () => T) => T;
            settleMass: (...args: any[]) => bigint;
            isTerminalCondition: (...args: any[]) => any;
        }
    ): bigint {
        const stack: Array<{ mass: bigint, meta: bigint, combo: PackedCombo, depth: number }> = [
            { mass: initialMass, meta: initialMeta, combo: initialCombo, depth: 0 }
        ];

        let totalResolvedFromTrees = 0n;

        while (stack.length > 0) {
            const { mass: incomingMass, meta, combo, depth } = stack.pop()!;
            
            const blueprint = this.expansionCache.get(meta);
            if (!blueprint) continue;

            const { registry, timing, cat, guaranteedFirstId } = ctx;
            const currentBitset = meta >> 8n;
            const probContinue = blueprint.probContinue;
            
            // Split mass into stop vs forward
            const { probStop, probForward, scaleLoss } = searchProcessor.withTiming(timing, 'settlingMs', () => {
                const pStop = ProbUtils.scale(incomingMass, (PRECISION - probContinue));
                const pForward = ProbUtils.scale(incomingMass, probContinue);
                const loss = incomingMass - (pStop + pForward);
                return { probStop: pStop, probForward: pForward, scaleLoss: loss };
            });

            const remStop = searchProcessor.withTiming(timing, 'settlingMs', () => 
                searchProcessor.settleMass(
                    registry, cat === "book", blueprint.currentCount, blueprint.currentCombo, blueprint.currentEnchants, 
                    probStop, guaranteedFirstId, registry.enchantToIndex, registry.indexToEnchant, 
                    ctx.results, ctx.countMass, ctx.anyMass, ctx.rankMass
                )
            );

            // Terminal Check
            const term = searchProcessor.isTerminalCondition(
                blueprint.currentCount, cat === "book", probForward, ctx.results.size, ctx.resultsLimit, 
                blueprint.currentCombo, ctx.results.has(blueprint.currentCombo), registry.multiEnchantBooks, 
                ProbUtils.toBigInt(0.0000000001) // SYSTEM_THRESHOLD_FLOOR
            );

            if (term.isTerminal || blueprint.totalWeight === 0) {
                totalResolvedFromTrees += this.handleTerminal(incomingMass, probStop, probForward, remStop, scaleLoss, blueprint, term, ctx, searchProcessor);
                continue;
            }

            // Standard expansion path
            const resolvedSub = this.processExpansionStep(probStop, probForward, remStop, scaleLoss, currentBitset, blueprint, ctx, depth, stack, searchProcessor);
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
            withTiming: <T>(timing: any, bucket: string, fn: () => T) => T;
            settleMass: (...args: any[]) => bigint;
        }
    ): bigint {
        const { registry, timing, cat, guaranteedFirstId, instrumentation } = ctx;
        
        const remForward = searchProcessor.withTiming(timing, 'settlingMs', () => 
            searchProcessor.settleMass(
                registry, cat === "book", blueprint.currentCount, blueprint.currentCombo, blueprint.currentEnchants, 
                probForward, guaranteedFirstId, registry.enchantToIndex, registry.indexToEnchant, 
                ctx.results, ctx.countMass, ctx.anyMass, ctx.rankMass
            )
        );

        const localRounding = remStop + remForward + scaleLoss;
        
        this.accountant.record('resolved', probStop - remStop);
        this.accountant.record('rounding', localRounding);
        
        if (term.isTooSmall) {
            if (instrumentation) instrumentation.totalPrunedNodes++;
            this.accountant.record('sieved', probForward - remForward);
        } else if (term.isLimitReached) {
            this.accountant.record('overflow', probForward - remForward);
        } else if (term.isMapFull) {
            this.accountant.record('capped', probForward - remForward);
        } else if (blueprint.totalWeight === 0) {
            this.accountant.record('resolved', probForward - remForward);
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
        depth: number,
        stack: Array<{ mass: bigint, meta: bigint, combo: PackedCombo, depth: number }>,
        searchProcessor: any
    ): bigint {
        const { registry, timing, instrumentation, queue, guaranteedFirstId } = ctx;

        const eligibleCount = blueprint.eligibleCount;
        const splits = DistributionPool.getBuffer(depth);

        searchProcessor.withTiming(timing, 'distributionMs', () => {
            const individualRemainder = probForward % BigInt(blueprint.totalWeight);
            this.accountant.record('rounding', individualRemainder);

            const { recovered } = ProbUtils.distributeWithResidue(
                probForward, blueprint.eligibleWeights, blueprint.totalWeight, splits, blueprint, eligibleCount
            );
            
            if (recovered > 0n) {
                this.accountant.subtract('rounding', recovered);
                this.accountant.record('recoveredRounding', recovered);
                if (instrumentation) instrumentation.roundingErrorEvents++;
            }
        });

        const guaranteedInCombo = guaranteedFirstId != null && (currentBitset & (1n << BigInt(guaranteedFirstId))) !== 0n;

        for (let i = 0; i < eligibleCount; i++) {
            const pNext = splits[i];
            if (pNext === 0n) continue;

            const nextPacked = ComboUtils.packAppend(blueprint.currentCombo, blueprint.eligibleEnchants[i], guaranteedFirstId, guaranteedInCombo, registry.enchantToIndex) as PackedCombo;
            const nextId = ComboUtils.getEnchantId(blueprint.eligibleEnchants[i]);
            const nextMeta = ((currentBitset | (1n << BigInt(nextId))) << 8n) | BigInt(blueprint.nextLevel);

            ProbUtils.addItemMass(ctx.anyMass, nextId, pNext);
            ProbUtils.addItemMass(ctx.rankMass, blueprint.eligibleEnchants[i], pNext);

            if (this.expansionCache.has(nextMeta) && depth < ProbabilityMassTracker.MAX_RECURSION_DEPTH) {
                stack.push({ mass: pNext, meta: nextMeta, combo: nextPacked, depth: depth + 1 });
            } else {
                this.accountant.record('pending', pNext);
                queue.pushOrMerge(nextMeta, pNext, blueprint.nextLevel, nextPacked);
            }
        }

        this.accountant.record('resolved', probStop - remStop);
        this.accountant.record('rounding', remStop + scaleLoss);
        
        return (probStop - remStop);
    }

    public clone(): ProbabilityMassTracker {
        return new ProbabilityMassTracker(this.getBookkeeping(), new Map(this.expansionCache));
    }
}
