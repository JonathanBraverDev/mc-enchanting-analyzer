import { PACKING_CONSTANTS } from '#constants/engine.js';
import { getEligiblePool, getEnchantability, getFullEnchantName } from '#core/registry.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import type {
    ClueSignalAdvisorView,
    ClueSignalRecommendationView,
    LevelClueSignalAdvisorView,
    LevelClueSignalRecommendationView,
    RegistryState
} from '#types/index.js';
import { ProbUtils } from '#utils/index.js';

interface MutableSignalBucket {
    clueMass: number;
    weightedModifiedLevel: number;
}

export class ClueSignalAdvisorService {
    private static readonly MIN_CLUE_SHARE = 0.001;
    private static readonly MIN_MODIFIED_LEVEL_LIFT = 0.05;
    private static readonly distributionService = new ModifiedLevelDistributionService();

    public static recommend(
        registry: RegistryState,
        category: string,
        material: string,
        xpLevel: number,
        limit = 5
    ): ClueSignalAdvisorView | undefined {
        if (limit <= 0) return undefined;

        const enchantability = getEnchantability(registry, material, category);
        const distribution = this.distributionService.getModifiedLevelDist(registry, xpLevel, enchantability);
        const baselineModifiedLevel = this.getAverageModifiedLevel(distribution);
        const buckets = new Map<number, MutableSignalBucket>();

        for (const [modifiedLevelText, levelMass] of Object.entries(distribution)) {
            const modifiedLevel = Number(modifiedLevelText);
            const pool = getEligiblePool(registry, category, modifiedLevel);
            const totalWeight = this.getPoolWeight(registry, pool);
            if (totalWeight <= 0) continue;

            const levelShare = ProbUtils.toNumber(levelMass);
            for (const idAndRank of pool) {
                const enchantmentId = idAndRank >> PACKING_CONSTANTS.ENCHANT_SHIFT;
                const weight = registry.weightMap[enchantmentId] ?? 0;
                if (weight <= 0) continue;

                const clueShare = levelShare * (weight / totalWeight);
                let bucket = buckets.get(idAndRank);
                if (!bucket) {
                    bucket = { clueMass: 0, weightedModifiedLevel: 0 };
                    buckets.set(idAndRank, bucket);
                }

                bucket.clueMass += clueShare;
                bucket.weightedModifiedLevel += clueShare * modifiedLevel;
            }
        }

        const recommendations: ClueSignalRecommendationView[] = [];
        for (const [idAndRank, bucket] of buckets) {
            if (bucket.clueMass < this.MIN_CLUE_SHARE) continue;

            const averageModifiedLevel = bucket.weightedModifiedLevel / bucket.clueMass;
            const modifiedLevelLift = averageModifiedLevel - baselineModifiedLevel;
            if (modifiedLevelLift < this.MIN_MODIFIED_LEVEL_LIFT) continue;

            recommendations.push({
                idAndRank,
                label: getFullEnchantName(registry, idAndRank),
                clueShare: bucket.clueMass,
                averageModifiedLevel,
                baselineModifiedLevel,
                modifiedLevelLift
            });
        }

        recommendations.sort((a, b) => this.compareRecommendation(a, b));
        return recommendations.length > 0
            ? { recommendations: recommendations.slice(0, limit) }
            : undefined;
    }

    public static summarizeLevels(
        registry: RegistryState,
        category: string,
        material: string,
        maxXpLevel: number,
        limit = 5
    ): LevelClueSignalAdvisorView | undefined {
        if (limit <= 0) return undefined;

        const recommendations: LevelClueSignalRecommendationView[] = [];
        for (let xpLevel = 1; xpLevel <= maxXpLevel; xpLevel++) {
            const advisor = this.recommend(registry, category, material, xpLevel, limit);
            if (!advisor) continue;

            for (const recommendation of advisor.recommendations) {
                recommendations.push({ ...recommendation, xpLevel });
            }
        }

        recommendations.sort((a, b) => this.compareRecommendation(a, b));
        return recommendations.length > 0
            ? { recommendations: recommendations.slice(0, limit) }
            : undefined;
    }

    private static getAverageModifiedLevel(distribution: Record<string, bigint>): number {
        let weighted = 0;
        let mass = 0;
        for (const [modifiedLevelText, levelMass] of Object.entries(distribution)) {
            const share = ProbUtils.toNumber(levelMass);
            weighted += Number(modifiedLevelText) * share;
            mass += share;
        }

        return mass > 0 ? weighted / mass : 0;
    }

    private static getPoolWeight(registry: RegistryState, pool: readonly number[]): number {
        let total = 0;
        for (const idAndRank of pool) {
            const enchantmentId = idAndRank >> PACKING_CONSTANTS.ENCHANT_SHIFT;
            total += registry.weightMap[enchantmentId] ?? 0;
        }
        return total;
    }

    private static compareRecommendation(
        a: Pick<ClueSignalRecommendationView, 'modifiedLevelLift' | 'averageModifiedLevel' | 'clueShare' | 'label'>,
        b: Pick<ClueSignalRecommendationView, 'modifiedLevelLift' | 'averageModifiedLevel' | 'clueShare' | 'label'>
    ): number {
        if (a.modifiedLevelLift !== b.modifiedLevelLift) return b.modifiedLevelLift - a.modifiedLevelLift;
        if (a.averageModifiedLevel !== b.averageModifiedLevel) return b.averageModifiedLevel - a.averageModifiedLevel;
        if (a.clueShare !== b.clueShare) return b.clueShare - a.clueShare;
        return a.label.localeCompare(b.label);
    }
}
