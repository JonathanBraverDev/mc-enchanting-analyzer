import { PRECISION, ProbUtils, ComboUtils } from '../utils/index.js';
import { ENGINE_DEFAULTS } from '../core/config.js';
import { 
    ExpansionBlueprint, 
    RegistryState, 
    EngineInstrumentation, 
    SearchTiming, 
    PackedCombo, 
    PackedEnchant,
    MassBookkeeping
} from '../types/index.js';
import { MassAccountant } from './MassAccountant.js';
import { SearchHeap } from '../utils/collections/SearchHeap.js';
import { SearchService } from './search.js';

export class ResidualMassHarvester {
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
        registry: RegistryState,
        cat: string,
        guaranteedFirstId: number | null,
        pool: PackedEnchant[],
        poolWeights: number[],
        results: Map<PackedCombo, bigint>,
        queue: SearchHeap,
        anyMass: BigUint64Array,
        rankMass: BigUint64Array,
        countMass: BigUint64Array,
        resultsLimit: number,
        accountant: MassAccountant,
        instrumentation?: EngineInstrumentation,
        timing?: SearchTiming,
        depth: number = 0
    ): bigint {
        const blueprint = this.expansionCache.get(meta);
        if (!blueprint) return 0n;

        const { enchantToIndex, indexToEnchant } = registry;
        const currentBitset = meta >> 8n;
        const currentLevel = Number(meta & 0xFFn);
        const currentCount = blueprint.currentCount;
        const currentCombo = blueprint.currentCombo;
        const currentEnchants = blueprint.currentEnchants;
        const isBook = cat === "book";

        const probContinue = blueprint.probContinue;
        
        // Split mass into stop vs forward
        let startSettling = 0;
        if (timing) startSettling = performance.now();
        
        const probStop = ProbUtils.scale(incomingMass, (PRECISION - probContinue));
        const remStop = SearchService.settleMass(
            registry, isBook, currentCount, currentCombo, currentEnchants, 
            probStop, guaranteedFirstId, enchantToIndex, indexToEnchant, 
            results, countMass, anyMass, rankMass
        );

        const probForward = ProbUtils.scale(incomingMass, probContinue);

        // Safety checks (same as in SearchService)
        const floor = ProbUtils.toBigInt(ENGINE_DEFAULTS.SYSTEM_THRESHOLD_FLOOR);
        const isLimitReached = currentCount >= (isBook && !registry.multiEnchantBooks ? 1 : ENGINE_DEFAULTS.MAX_ENCHANTS_PER_ITEM);
        const isTooSmall = probForward < floor;
        const isMapFull = results.size >= resultsLimit && !results.has(currentCombo);

        if (isLimitReached || isTooSmall || isMapFull) {
            const remForward = SearchService.settleMass(
                registry, isBook, currentCount, currentCombo, currentEnchants, 
                probForward, guaranteedFirstId, enchantToIndex, indexToEnchant, 
                results, countMass, anyMass, rankMass
            );
            if (timing) timing.settlingMs += performance.now() - startSettling;
            
            const localRounding = remStop + remForward + (incomingMass - (probStop + probForward));
            
            accountant.record('resolved', probStop - remStop);
            accountant.record('rounding', localRounding);
            
            if (isTooSmall) {
                if (instrumentation) instrumentation.totalPrunedNodes++;
                accountant.record('sieved', probForward - remForward);
            } else if (isLimitReached) {
                accountant.record('overflow', probForward - remForward);
            } else {
                accountant.record('capped', probForward - remForward);
            }

            if (localRounding > 0n && instrumentation) instrumentation.roundingErrorEvents++;
            return probStop - remStop;
        }

        if (timing) timing.settlingMs += performance.now() - startSettling;

        const totalWeight = blueprint.totalWeight;
        const eligibleCount = blueprint.eligibleCount;
        const nextLevel = blueprint.nextLevel;
        const eligible = blueprint.eligibleEnchants;

        if (totalWeight === 0) {
            let startEndSettling = 0;
            if (timing) startEndSettling = performance.now();
            const remForward = SearchService.settleMass(
                registry, isBook, currentCount, currentCombo, currentEnchants, 
                probForward, guaranteedFirstId, enchantToIndex, indexToEnchant, 
                results, countMass, anyMass, rankMass
            );
            if (timing) timing.settlingMs += performance.now() - startEndSettling;

            const localRounding = remStop + remForward + (incomingMass - (probStop + probForward));

            accountant.record('resolved', (probStop + probForward) - (remStop + remForward));
            accountant.record('rounding', localRounding);
            if (localRounding > 0n && instrumentation) instrumentation.roundingErrorEvents++;
            return (probStop + probForward) - (remStop + remForward);
        }

        let startDist = 0;
        if (timing) startDist = performance.now();
        
        // We need a local buffer for splits to avoid clobbering other calls in the recursion
        const splits = new BigUint64Array(eligibleCount);

        const individualRemainder = probForward % BigInt(totalWeight);
        accountant.record('rounding', individualRemainder);

        const { recovered } = ProbUtils.distributeWithResidue(
            probForward, blueprint.eligibleWeights, totalWeight, splits, blueprint, eligibleCount
        );
        
        if (recovered > 0n) {
            accountant.subtract('rounding', recovered);
            accountant.record('recoveredRounding', recovered);
            if (instrumentation) instrumentation.roundingErrorEvents++;
        }

        if (timing) timing.distributionMs += performance.now() - startDist;

        const guaranteedInCombo = guaranteedFirstId !== null && (currentBitset & (1n << BigInt(guaranteedFirstId))) !== 0n;
        let totalResolvedFromChildren = 0n;

        for (let i = 0; i < eligibleCount; i++) {
            const pNext = splits[i];
            if (pNext === 0n) continue;

            const nextPacked = ComboUtils.packAppend(currentCombo, eligible[i], guaranteedFirstId, guaranteedInCombo, enchantToIndex);
            const nextId = ComboUtils.getEnchantId(eligible[i]);
            const nextMeta = ((currentBitset | (1n << BigInt(nextId))) << 8n) | BigInt(nextLevel);

            ProbUtils.addItemMass(anyMass, nextId, pNext);
            ProbUtils.addItemMass(rankMass, eligible[i], pNext);

            // RECURSIVE FORWARDING
            // If the next level is deeper than humanly possible (e.g. 100+), we have a cycle or bug.
            // But max enchants is 6, so depth 10 is safe.
            const resolved = (depth < 10) 
                ? this.forwardMass(
                    pNext, nextMeta, nextPacked, registry, cat, guaranteedFirstId, 
                    pool, poolWeights, results, queue, anyMass, rankMass, countMass, 
                    resultsLimit, accountant, instrumentation, timing, depth + 1
                )
                : 0n;

            if (resolved === 0n) {
                // Not cached or reached recursion limit, push to queue
                accountant.record('pending', pNext);
                queue.pushOrMerge(nextMeta, pNext, nextLevel, nextPacked);
            } else {
                totalResolvedFromChildren += resolved;
            }
        }

        const scaleRoundingLoss = incomingMass - (probStop + probForward);
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
