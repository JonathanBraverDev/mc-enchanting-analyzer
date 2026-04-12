import { PRECISION, ProbUtils, ComboUtils } from '../utils/index.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { 
    ExpansionBlueprint, 
    RegistryState, 
    EngineInstrumentation, 
    SearchTiming, 
    PackedCombo, 
    PackedEnchant,
    MassBookkeeping,
    ForwardingContext
} from '../types/index.js';
import { MassAccountant } from './MassAccountant.js';
import { SearchHeap } from '../utils/collections/SearchHeap.js';
import { SearchService } from './search.js';

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
     * Recursively forwards probability mass to cached children, bypassing the priority queue.
     * Returns the total mass successfully settled into results.
     */
    public forwardMass(
        incomingMass: bigint,
        meta: bigint,
        combo: number,
        cat: string,
        guaranteedFirstId: number | null,
        pool: PackedEnchant[],
        poolWeights: number[],
        ctx: ForwardingContext,
        depth: number = 0
    ): bigint {
        const blueprint = this.expansionCache.get(meta);
        if (!blueprint) return 0n;

        const { registry, timing, accountant, instrumentation } = ctx;
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
            return this.handleTerminal(incomingMass, probStop, probForward, remStop, scaleRoundingLoss, blueprint, term, cat, guaranteedFirstId, ctx);
        }

        // Standard expansion path
        return this.processExpansion(incomingMass, probStop, probForward, remStop, scaleRoundingLoss, meta, currentBitset, blueprint, cat, guaranteedFirstId, pool, poolWeights, ctx, depth);
    }

    private handleTerminal(
        incomingMass: bigint,
        probStop: bigint,
        probForward: bigint,
        remStop: bigint,
        scaleRoundingLoss: bigint,
        blueprint: ExpansionBlueprint,
        term: { isLimitReached: boolean; isTooSmall: boolean; isMapFull: boolean },
        cat: string,
        guaranteedFirstId: number | null,
        ctx: ForwardingContext
    ): bigint {
        const { registry, timing, accountant, instrumentation } = ctx;
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

    private processExpansion(
        incomingMass: bigint,
        probStop: bigint,
        probForward: bigint,
        remStop: bigint,
        scaleRoundingLoss: bigint,
        meta: bigint,
        currentBitset: bigint,
        blueprint: ExpansionBlueprint,
        cat: string,
        guaranteedFirstId: number | null,
        pool: PackedEnchant[],
        poolWeights: number[],
        ctx: ForwardingContext,
        depth: number
    ): bigint {
        const { registry, timing, accountant, instrumentation, queue } = ctx;
        const { enchantToIndex } = registry;

        // Residue-aware distribution
        const eligibleCount = blueprint.eligibleCount;
        const splits = new BigUint64Array(eligibleCount);

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
        let totalResolvedFromChildren = 0n;

        for (let i = 0; i < eligibleCount; i++) {
            const pNext = splits[i];
            if (pNext === 0n) continue;

            const nextPacked = ComboUtils.packAppend(blueprint.currentCombo, blueprint.eligibleEnchants[i], guaranteedFirstId, guaranteedInCombo, enchantToIndex);
            const nextId = ComboUtils.getEnchantId(blueprint.eligibleEnchants[i]);
            const nextMeta = ((currentBitset | (1n << BigInt(nextId))) << 8n) | BigInt(blueprint.nextLevel);

            ProbUtils.addItemMass(ctx.anyMass, nextId, pNext);
            ProbUtils.addItemMass(ctx.rankMass, blueprint.eligibleEnchants[i], pNext);

            // RECURSIVE FORWARDING
            const resolved = (depth < ResidualMassHarvester.MAX_RECURSION_DEPTH) 
                ? this.forwardMass(
                    pNext, nextMeta, nextPacked, cat, guaranteedFirstId, 
                    pool, poolWeights, ctx, depth + 1
                )
                : 0n;

            if (resolved === 0n) {
                accountant.record('pending', pNext);
                queue.pushOrMerge(nextMeta, pNext, blueprint.nextLevel, nextPacked);
            } else {
                totalResolvedFromChildren += resolved;
            }
        }

        accountant.record('resolved', probStop - remStop);
        accountant.record('rounding', remStop + scaleRoundingLoss);
        if ((remStop + scaleRoundingLoss) > 0n && instrumentation) instrumentation.roundingErrorEvents++;
        
        return (probStop - remStop) + totalResolvedFromChildren;
    }

    /**
     * Required for cache serialization/cloning.
     */
    public clone(): ResidualMassHarvester {
        return new ResidualMassHarvester(new Map(this.expansionCache));
    }
}
