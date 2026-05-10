import { PACKING_CONSTANTS } from '#constants/engine.js';
import { getEligiblePool, getEnchantability, getFullEnchantName } from '#core/registry.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { TargetAnalysisService } from '#services/TargetAnalysisService.js';
import type {
    ChartCellView,
    PackedCombo,
    PackedTargetRequirement,
    RegistryState,
    TargetLevelClueAdvisorView,
    TargetLevelClueRecommendationView
} from '#types/index.js';
import type { V7PendingFrontierEntry } from '#lib/v7/search/SearchRun.js';
import { ComboUtils, PRECISION, ProbUtils } from '#utils/index.js';

export interface TargetClueAdvisorRequest {
    combos: ReadonlyMap<PackedCombo, bigint>;
    indexToEnchant: number[];
    targets: PackedTargetRequirement[];
    registry: RegistryState;
    v7PendingEntries?: readonly V7PendingFrontierEntry[] | undefined;
    limit?: number | undefined;
}

export interface TargetClueRecommendation {
    idAndRank: number;
    label: string;
    targetChanceMass: bigint;
    clueMass: bigint;
    targetAndClueMass: bigint;
    anyBaselineChanceMass: bigint;
    liftOverAnyBaseline: number;
    compatibleBaselineChanceMass: bigint;
    liftOverCompatibleBaseline: number;
}

export interface TargetClueAdvisorResult {
    recommendations: TargetClueRecommendation[];
}

interface MutableClueAdviceBucket {
    clueMass: bigint;
    targetAndClueMass: bigint;
}

export class TargetClueAdvisorService {
    private static readonly distributionService = new ModifiedLevelDistributionService();

    public static recommend(request: TargetClueAdvisorRequest): TargetClueAdvisorResult | undefined {
        const {
            combos,
            indexToEnchant,
            targets,
            registry,
            v7PendingEntries = [],
            limit = 5
        } = request;

        if (targets.length === 0 || limit <= 0) return undefined;

        const buckets = new Map<number, MutableClueAdviceBucket>();

        for (const [packed, mass] of combos) {
            this.addComboContribution(buckets, packed, mass, indexToEnchant, targets);
        }

        for (const entry of v7PendingEntries) {
            this.addComboContribution(buckets, entry.combo, entry.mass, indexToEnchant, targets);
        }


        const anyBaselineChanceMass = this.calculateBaselineChance(buckets, () => true);
        const compatibleBaselineChanceMass = this.calculateBaselineChance(
            buckets,
            (idAndRank) => this.isCompatibleClue(idAndRank, targets, registry)
        );
        const recommendations: TargetClueRecommendation[] = [];
        for (const [idAndRank, bucket] of buckets) {
            if (bucket.clueMass <= 0n || bucket.targetAndClueMass <= 0n) continue;

            const targetChanceMass = this.divideMass(bucket.targetAndClueMass, bucket.clueMass);
            recommendations.push({
                idAndRank,
                label: getFullEnchantName(registry, idAndRank),
                targetChanceMass,
                clueMass: bucket.clueMass,
                targetAndClueMass: bucket.targetAndClueMass,
                anyBaselineChanceMass,
                liftOverAnyBaseline: this.divideAsNumber(targetChanceMass, anyBaselineChanceMass),
                compatibleBaselineChanceMass,
                liftOverCompatibleBaseline: this.divideAsNumber(targetChanceMass, compatibleBaselineChanceMass)
            });
        }

        recommendations.sort((a, b) => this.compareRecommendation(a, b));
        return recommendations.length > 0
            ? { recommendations: recommendations.slice(0, limit) }
            : undefined;
    }

    public static supportsTargetsAtXp(
        registry: RegistryState,
        item: string,
        material: string,
        xpLevel: number,
        targets: PackedTargetRequirement[]
    ): boolean {
        if (targets.length === 0) return false;

        const enchantability = getEnchantability(registry, material, item);
        const distribution = this.distributionService.getModifiedLevelDist(registry, xpLevel, enchantability);

        for (const modLevelText of Object.keys(distribution)) {
            const pool = getEligiblePool(registry, item, Number(modLevelText));
            if (this.poolSupportsTargets(pool, targets)) return true;
        }

        return false;
    }

    public static summarizeSweep(
        sweep: ChartCellView[],
        limit = 5
    ): TargetLevelClueAdvisorView | undefined {
        if (limit <= 0) return undefined;

        const recommendations: TargetLevelClueRecommendationView[] = [];
        for (const cell of sweep) {
            if (!cell?.clueAdvisor) continue;
            for (const recommendation of cell.clueAdvisor.recommendations) {
                recommendations.push({
                    ...recommendation,
                    xpLevel: cell.xpLevel
                });
            }
        }

        recommendations.sort((a, b) => this.compareViewRecommendation(a, b));
        return recommendations.length > 0
            ? { recommendations: recommendations.slice(0, limit) }
            : undefined;
    }

    private static addComboContribution(
        buckets: Map<number, MutableClueAdviceBucket>,
        packed: PackedCombo,
        mass: bigint,
        indexToEnchant: number[],
        targets: PackedTargetRequirement[]
    ): void {
        if (mass <= 0n) return;

        const count = ComboUtils.getCount(packed);
        if (count === 0) return;

        const matchesTarget = TargetAnalysisService.matchesCombo(packed, targets, indexToEnchant);
        const quotient = mass / BigInt(count);
        const remainder = Number(mass % BigInt(count));

        let mult = 1;
        for (let i = 0; i < count; i++, mult *= PACKING_CONSTANTS.BYTE_BASIS) {
            const idx = Math.floor(packed / mult) % PACKING_CONSTANTS.BYTE_BASIS;
            const clue = indexToEnchant[idx];
            if (clue === undefined) break;

            const share = quotient + (i < remainder ? 1n : 0n);
            if (share <= 0n) continue;

            let bucket = buckets.get(clue);
            if (!bucket) {
                bucket = { clueMass: 0n, targetAndClueMass: 0n };
                buckets.set(clue, bucket);
            }

            bucket.clueMass += share;
            if (matchesTarget) bucket.targetAndClueMass += share;
        }
    }

    private static poolSupportsTargets(pool: readonly number[], targets: PackedTargetRequirement[]): boolean {
        for (const target of targets) {
            let found = false;
            for (const candidate of pool) {
                const enchantmentId = candidate >> PACKING_CONSTANTS.ENCHANT_SHIFT;
                const rank = candidate & PACKING_CONSTANTS.RANK_MASK;
                if (enchantmentId === target.enchantmentId && rank >= target.rank) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }

        return true;
    }

    private static calculateBaselineChance(
        buckets: Map<number, MutableClueAdviceBucket>,
        includeClue: (idAndRank: number) => boolean
    ): bigint {
        let clueMass = 0n;
        let targetAndClueMass = 0n;

        for (const [idAndRank, bucket] of buckets) {
            if (!includeClue(idAndRank)) continue;
            clueMass += bucket.clueMass;
            targetAndClueMass += bucket.targetAndClueMass;
        }

        return this.divideMass(targetAndClueMass, clueMass);
    }

    private static isCompatibleClue(
        idAndRank: number,
        targets: PackedTargetRequirement[],
        registry: RegistryState
    ): boolean {
        const enchantmentId = idAndRank >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        const rank = idAndRank & PACKING_CONSTANTS.RANK_MASK;

        for (const target of targets) {
            if (target.enchantmentId === enchantmentId) {
                return rank >= target.rank;
            }

            const conflicts = registry.conflictBitsets[target.enchantmentId] ?? 0n;
            if ((conflicts & (1n << BigInt(enchantmentId))) !== 0n) return false;
        }

        return true;
    }

    private static divideMass(part: bigint, whole: bigint): bigint {
        if (whole <= 0n) return 0n;
        if (part >= whole) return PRECISION;
        return ProbUtils.roundScale(part, PRECISION, whole);
    }

    private static divideAsNumber(part: bigint, whole: bigint): number {
        if (whole <= 0n) return 0;
        return ProbUtils.toNumber(part) / ProbUtils.toNumber(whole);
    }

    private static compareRecommendation(a: TargetClueRecommendation, b: TargetClueRecommendation): number {
        if (a.targetChanceMass !== b.targetChanceMass) return a.targetChanceMass > b.targetChanceMass ? -1 : 1;
        if (a.targetAndClueMass !== b.targetAndClueMass) return a.targetAndClueMass > b.targetAndClueMass ? -1 : 1;
        if (a.clueMass !== b.clueMass) return a.clueMass > b.clueMass ? -1 : 1;
        return a.label.localeCompare(b.label);
    }

    private static compareViewRecommendation(
        a: TargetLevelClueRecommendationView,
        b: TargetLevelClueRecommendationView
    ): number {
        if (a.targetChance !== b.targetChance) return b.targetChance - a.targetChance;
        if (a.targetAndClueShare !== b.targetAndClueShare) return b.targetAndClueShare - a.targetAndClueShare;
        if (a.clueShare !== b.clueShare) return b.clueShare - a.clueShare;
        if (a.xpLevel !== b.xpLevel) return b.xpLevel - a.xpLevel;
        return a.label.localeCompare(b.label);
    }
}
