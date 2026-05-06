import { PACKING_CONSTANTS } from '#constants/engine.js';
import { getFullEnchantName } from '#core/registry.js';
import { TargetAnalysisService } from '#services/TargetAnalysisService.js';
import type {
    PackedCombo,
    PackedTargetRequirement,
    RegistryState,
    SearchFrontierSnapshot
} from '#types/index.js';
import { ComboUtils, ProbUtils, PRECISION } from '#utils/index.js';

export interface TargetClueAdvisorRequest {
    combos: Map<PackedCombo, bigint>;
    indexToEnchant: number[];
    targets: PackedTargetRequirement[];
    registry: RegistryState;
    frontiers?: SearchFrontierSnapshot[] | undefined;
    limit?: number | undefined;
}

export interface TargetClueRecommendation {
    idAndRank: number;
    label: string;
    targetChanceMass: bigint;
    clueMass: bigint;
    targetAndClueMass: bigint;
}

export interface TargetClueAdvisorResult {
    recommendations: TargetClueRecommendation[];
}

interface MutableClueAdviceBucket {
    clueMass: bigint;
    targetAndClueMass: bigint;
}

export class TargetClueAdvisorService {
    public static recommend(request: TargetClueAdvisorRequest): TargetClueAdvisorResult | undefined {
        const {
            combos,
            indexToEnchant,
            targets,
            registry,
            frontiers = [],
            limit = 5
        } = request;

        if (targets.length === 0 || limit <= 0) return undefined;

        const buckets = new Map<number, MutableClueAdviceBucket>();

        for (const [packed, mass] of combos) {
            this.addComboContribution(buckets, packed, mass, indexToEnchant, targets);
        }

        for (const { frontier, graph, scale } of frontiers) {
            frontier.forEachNode((nodeId, prob) => {
                this.addComboContribution(
                    buckets,
                    graph.getCombo(nodeId),
                    ProbUtils.scale(prob, scale),
                    indexToEnchant,
                    targets
                );
            });
        }

        const recommendations: TargetClueRecommendation[] = [];
        for (const [idAndRank, bucket] of buckets) {
            if (bucket.clueMass <= 0n || bucket.targetAndClueMass <= 0n) continue;

            recommendations.push({
                idAndRank,
                label: getFullEnchantName(registry, idAndRank),
                targetChanceMass: this.divideMass(bucket.targetAndClueMass, bucket.clueMass),
                clueMass: bucket.clueMass,
                targetAndClueMass: bucket.targetAndClueMass
            });
        }

        recommendations.sort((a, b) => this.compareRecommendation(a, b));
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

    private static divideMass(part: bigint, whole: bigint): bigint {
        if (whole <= 0n) return 0n;
        if (part >= whole) return PRECISION;
        return ProbUtils.roundScale(part, PRECISION, whole);
    }

    private static compareRecommendation(a: TargetClueRecommendation, b: TargetClueRecommendation): number {
        if (a.targetChanceMass !== b.targetChanceMass) return a.targetChanceMass > b.targetChanceMass ? -1 : 1;
        if (a.targetAndClueMass !== b.targetAndClueMass) return a.targetAndClueMass > b.targetAndClueMass ? -1 : 1;
        if (a.clueMass !== b.clueMass) return a.clueMass > b.clueMass ? -1 : 1;
        return a.label.localeCompare(b.label);
    }
}
