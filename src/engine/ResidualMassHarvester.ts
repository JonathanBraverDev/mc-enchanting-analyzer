import { PRECISION, ProbUtils, ComboUtils } from '../utils/index.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { ExpansionBlueprint, ForwardingContext } from '../types/index.js';
import { SearchService } from './search.js';
import { DistributionPool } from './DistributionPool.js';

export class ResidualMassHarvester {
    private static readonly MAX_RECURSION_DEPTH = 10;
    private expansionCache = new Map<bigint, ExpansionBlueprint>();

    constructor(initialCache?: Map<bigint, ExpansionBlueprint>) {
        if (initialCache) {
            this.expansionCache = initialCache;
        }
    }

    public registerExpansion(key: bigint, blueprint: ExpansionBlueprint): void {
        this.expansionCache.set(key, blueprint);
    }

    public getCacheSize(): number {
        return this.expansionCache.size;
    }

    public has(key: bigint): boolean {
        return this.expansionCache.has(key);
    }

    public get(key: bigint): ExpansionBlueprint | undefined {
        return this.expansionCache.get(key);
    }

    /**
     * Forwards probability mass to cached children, bypassing the priority queue.
     * Uses an iterative stack-based approach to avoid recursion limit issues and maintain
     * linear memory flow.
     * 
     * The process follows:
     * 1. Check if node is cached.
     * 2. Split mass between 'stop' (settle now) and 'forward' (continue to children).
     * 3. If terminal condition reached or no children, settle all mass.
     * 4. Otherwise, distribute mass to children using residue-aware accounting.
     * 5. For each child: if cached and depth limit not reached, push to stack for next iteration.
     *    Otherwise, push to the main search priority queue.
     * 
     * Returns the total mass successfully settled into results across the entire subtree.
     */
    public forwardMass(
        initialMass: bigint,
        initialMeta: bigint,
        initialCombo: number,
        ctx: ForwardingContext
    ): bigint {
        const stack: Array<{ mass: bigint, meta: bigint, combo: number, depth: number }> = [
            { mass: initialMass, meta: initialMeta, combo: initialCombo, depth: 0 }
        ];

        let totalResolvedFromTrees = 0n;

        while (stack.length > 0) {
            const { mass: incomingMass, meta, combo, depth } = stack.pop()!;
            
            const blueprint = this.expansionCache.get(meta);
            if (!blueprint) continue;

            const { registry, timing, accountant, instrumentation, cat, guaranteedFirstId } = ctx;
            const { enchantToIndex, indexToEnchant } = registry;
            const currentBitset = SearchService.getBitsetFromMeta(meta);
            const currentCount = blueprint.currentCount;
            const currentCombo = blueprint.currentCombo;
            const currentEnchants = blueprint.currentEnchants;
            const isBook = cat === "book";

            const probContinue = blueprint.probContinue;
            
            // Split mass into stop vs forward
            const { probStop, probForward, localRounding: scaleRoundingLoss } = SearchService.withTiming(timing, 'settlingMs', () => {
                const pStop = ProbUtils.scale(incomingMass, (PRECISION - probContinue));
                const pForward = ProbUtils.scale(incomingMass, probContinue);
                const loss = incomingMass - (pStop + pForward);
                return { probStop: pStop, probForward: pForward, localRounding: loss };
            });

            const remStop = SearchService.withTiming(timing, 'settlingMs', () => 
                SearchService.settleMass(
                    registry, isBook, currentCount, currentCombo, currentEnchants, 
                    probStop, guaranteedFirstId, enchantToIndex, indexToEnchant, 
                    ctx.results, ctx.countMass, ctx.anyMass, ctx.rankMass
                )
            );

            // Terminal Check (Limit reached, too small, or results full)
            const floor = ProbUtils.toBigInt(ENGINE_DEFAULTS.SYSTEM_THRESHOLD_FLOOR);
            const term = SearchService.isTerminalCondition(
                currentCount, isBook, probForward, ctx.results.size, ctx.resultsLimit, 
                currentCombo, ctx.results.has(currentCombo), registry.multiEnchantBooks, floor
            );

            if (term.isTerminal || blueprint.totalWeight === 0) {
                totalResolvedFromTrees += this.handleTerminal(incomingMass, probStop, probForward, remStop, scaleRoundingLoss, blueprint, term, ctx);
                continue;
            }

            // Standard expansion path
            const resolvedSub = this.processExpansionStep(probStop, probForward, remStop, scaleRoundingLoss, currentBitset, blueprint, ctx, depth, stack);
            totalResolvedFromTrees += resolvedSub;
        }

        return totalResolvedFromTrees;
    }

    private handleTerminal(
        incomingMass: bigint,
        probStop: bigint,
        probForward: bigint,
        remStop: bigint,
        scaleRoundingLoss: bigint,
        blueprint: ExpansionBlueprint,
        term: { isLimitReached: boolean; isTooSmall: boolean; isMapFull: boolean },
        ctx: ForwardingContext
    ): bigint {
        const { registry, timing, accountant, instrumentation, cat, guaranteedFirstId } = ctx;
        const isBook = cat === "book";
        
        const remForward = SearchService.withTiming(timing, 'settlingMs', () => 
            SearchService.settleMass(
                registry, isBook, blueprint.currentCount, blueprint.currentCombo, blueprint.currentEnchants, 
                probForward, guaranteedFirstId, registry.enchantToIndex, registry.indexToEnchant, 
                ctx.results, ctx.countMass, ctx.anyMass, ctx.rankMass
            )
        );

        const localRounding = remStop + remForward + scaleRoundingLoss;
        
        accountant.record('resolved', probStop - remStop);
        accountant.record('rounding', localRounding);
        
        if (term.isTooSmall) {
            if (instrumentation) instrumentation.totalPrunedNodes++;
            accountant.record('sieved', probForward - remForward);
        } else if (term.isLimitReached) {
            accountant.record('overflow', probForward - remForward);
        } else if (term.isMapFull) {
            accountant.record('capped', probForward - remForward);
        } else if (blueprint.totalWeight === 0) {
            // No eligible enchants left to forward to
            accountant.record('resolved', probForward - remForward);
        }

        if (localRounding > 0n && instrumentation) instrumentation.roundingErrorEvents++;
        return (probStop - remStop) + (blueprint.totalWeight === 0 ? (probForward - remForward) : 0n);
    }

    private processExpansionStep(
        probStop: bigint,
        probForward: bigint,
        remStop: bigint,
        scaleRoundingLoss: bigint,
        currentBitset: bigint,
        blueprint: ExpansionBlueprint,
        ctx: ForwardingContext,
        depth: number,
        stack: Array<{ mass: bigint, meta: bigint, combo: number, depth: number }>
    ): bigint {
        const { registry, timing, accountant, instrumentation, queue, guaranteedFirstId } = ctx;
        const { enchantToIndex } = registry;

        // Residue-aware distribution using multiplexed shared buffer
        const eligibleCount = blueprint.eligibleCount;
        const splits = DistributionPool.getBuffer(depth);

        SearchService.withTiming(timing, 'distributionMs', () => {
            const individualRemainder = probForward % BigInt(blueprint.totalWeight);
            accountant.record('rounding', individualRemainder);

            const { recovered } = ProbUtils.distributeWithResidue(
                probForward, blueprint.eligibleWeights, blueprint.totalWeight, splits, blueprint, eligibleCount
            );
            
            if (recovered > 0n) {
                accountant.subtract('rounding', recovered);
                accountant.record('recoveredRounding', recovered);
                if (instrumentation) instrumentation.roundingErrorEvents++;
            }
        });

        const guaranteedInCombo = guaranteedFirstId !== null && (currentBitset & (1n << BigInt(guaranteedFirstId))) !== 0n;

        for (let i = 0; i < eligibleCount; i++) {
            const pNext = splits[i];
            if (pNext === 0n) continue;

            const nextPacked = ComboUtils.packAppend(blueprint.currentCombo, blueprint.eligibleEnchants[i], guaranteedFirstId, guaranteedInCombo, enchantToIndex);
            const nextId = ComboUtils.getEnchantId(blueprint.eligibleEnchants[i]);
            const nextMeta = ((currentBitset | (1n << BigInt(nextId))) << 8n) | BigInt(blueprint.nextLevel);

            ProbUtils.addItemMass(ctx.anyMass, nextId, pNext);
            ProbUtils.addItemMass(ctx.rankMass, blueprint.eligibleEnchants[i], pNext);

            // BRANCHING
            const isCached = this.expansionCache.has(nextMeta);
            if (isCached && depth < ResidualMassHarvester.MAX_RECURSION_DEPTH) {
                // Iterative push: replace recursion with stack visit
                stack.push({ mass: pNext, meta: nextMeta, combo: nextPacked, depth: depth + 1 });
            } else {
                // Not cached or reached depth limit, push to main search queue
                accountant.record('pending', pNext);
                queue.pushOrMerge(nextMeta, pNext, blueprint.nextLevel, nextPacked);
            }
        }

        accountant.record('resolved', probStop - remStop);
        accountant.record('rounding', remStop + scaleRoundingLoss);
        if ((remStop + scaleRoundingLoss) > 0n && instrumentation) instrumentation.roundingErrorEvents++;
        
        return (probStop - remStop);
    }

    /**
     * Required for cache serialization/cloning.
     */
    public clone(): ResidualMassHarvester {
        return new ResidualMassHarvester(new Map(this.expansionCache));
    }
}
