import type { MassAccountingBreakdown, MassAccountingDetails, MassAccountingDetailBucket, MassAccountingOperationDetails, MassAccountingStageDetails, MassBucketName, MassBucketUnits } from '#types/mass.js';
import { ProbUtils, PRECISION } from '#utils/index.js';

/**
 * Internal index mapping for probability mass buckets.
 */
const BUCKET_INDEX: Record<MassBucketName, number> = {
    resolved: 0,
    clueIncompatible: 1,
    pending: 2,
    sieved: 3,
    overflow: 4,
    capped: 5,
    rounding: 6,
    recoveredRounding: 7,
    recoveredSieved: 8
};
const BUCKET_COUNT = 9;
const MASS_BUCKET_LABELS: readonly MassBucketName[] = [
    'resolved',
    'clueIncompatible',
    'pending',
    'sieved',
    'overflow',
    'capped',
    'rounding',
    'recoveredRounding',
    'recoveredSieved'
];

const ACCOUNTING_STAGE = Object.freeze({
    Search: 0,
    Projection: 1
} as const);
const ACCOUNTING_STAGE_COUNT = 2;
const ACCOUNTING_DETAIL_OPERATION_COUNT = 8;
const ACCOUNTING_DETAIL_BUCKET_COUNT = BUCKET_COUNT;

export const SEARCH_MASS_OPERATION = Object.freeze({
    Seed: 0,
    Frontier: 1,
    Resolve: 2,
    EdgeSplit: 3,
    CluePrune: 4,
    ProbabilityFloor: 5,
    Overflow: 6,
    Residue: 7
} as const);
export type SearchMassOperation = typeof SEARCH_MASS_OPERATION[keyof typeof SEARCH_MASS_OPERATION];

export const SEARCH_MASS_BUCKET = Object.freeze({
    Resolved: BUCKET_INDEX.resolved,
    ClueIncompatible: BUCKET_INDEX.clueIncompatible,
    Pending: BUCKET_INDEX.pending,
    Sieved: BUCKET_INDEX.sieved,
    Overflow: BUCKET_INDEX.overflow,
    Capped: BUCKET_INDEX.capped,
    Rounding: BUCKET_INDEX.rounding,
    RecoveredRounding: BUCKET_INDEX.recoveredRounding,
    RecoveredSieved: BUCKET_INDEX.recoveredSieved
} as const);
export type SearchMassBucket = typeof SEARCH_MASS_BUCKET[keyof typeof SEARCH_MASS_BUCKET];

export const PROJECTION_MASS_OPERATION = Object.freeze({
    Results: 0,
    Pending: 1
} as const);
export type ProjectionMassOperation = typeof PROJECTION_MASS_OPERATION[keyof typeof PROJECTION_MASS_OPERATION];

export const PROJECTION_MASS_BUCKET = Object.freeze({
    Source: 0,
    Projected: 1,
    ClueIncompatible: 2,
    Loss: 3
} as const);
export type ProjectionMassBucket = typeof PROJECTION_MASS_BUCKET[keyof typeof PROJECTION_MASS_BUCKET];

const SEARCH_OPERATION_LABELS: readonly string[] = [
    'seed',
    'frontier',
    'resolve',
    'edgeSplit',
    'cluePrune',
    'probabilityFloor',
    'overflow',
    'residue'
];
const PROJECTION_OPERATION_LABELS: readonly string[] = [
    'results',
    'pending'
];
const PROJECTION_BUCKET_LABELS: readonly string[] = [
    'source',
    'projected',
    'clueIncompatible',
    'loss'
];

/**
 * Encapsulated state tracker for probability mass units.
 * Ensures strict conservation invariants and provides diagnostic visibility.
 */
export class ProbabilityMassAccountant {
    private data: BigUint64Array;
    private detailData: bigint[] | undefined;

    constructor(initialMass?: MassBucketUnits) {
        this.data = new BigUint64Array(BUCKET_COUNT);
        if (initialMass) {
            this.data[BUCKET_INDEX.resolved] = initialMass.resolved;
            this.data[BUCKET_INDEX.clueIncompatible] = initialMass.clueIncompatible;
            this.data[BUCKET_INDEX.pending] = initialMass.pending;
            this.data[BUCKET_INDEX.sieved] = initialMass.sieved;
            this.data[BUCKET_INDEX.overflow] = initialMass.overflow;
            this.data[BUCKET_INDEX.capped] = initialMass.capped;
            this.data[BUCKET_INDEX.rounding] = initialMass.rounding;
            this.data[BUCKET_INDEX.recoveredRounding] = initialMass.recoveredRounding;
            this.data[BUCKET_INDEX.recoveredSieved] = initialMass.recoveredSieved;
        }
    }

    /**
     * Records a positive mass event in the specified bucket.
     */
    public record(type: MassBucketName, prob: bigint): void {
        this.data[BUCKET_INDEX[type]!]! += prob;
    }

    /**
     * Subtracts mass from the specified bucket.
     */
    public subtract(type: MassBucketName, prob: bigint): void {
        this.data[BUCKET_INDEX[type]!]! -= prob;
    }

    public forSearchOperation(operation: SearchMassOperation): SearchMassRecorder {
        return new SearchMassRecorder(this, operation);
    }

    public forProjectionOperation(operation: ProjectionMassOperation): ProjectionMassRecorder {
        return new ProjectionMassRecorder(this, operation);
    }

    public recordSearch(operation: SearchMassOperation, bucket: SearchMassBucket, prob: bigint): void {
        if (prob === 0n) return;
        this.data[bucket]! += prob;
        this.recordDetail(ACCOUNTING_STAGE.Search, operation, bucket, prob);
    }

    public subtractSearch(operation: SearchMassOperation, bucket: SearchMassBucket, prob: bigint): void {
        if (prob === 0n) return;
        this.data[bucket]! -= prob;
        this.recordDetail(ACCOUNTING_STAGE.Search, operation, bucket, -prob);
    }

    public recordProjection(operation: ProjectionMassOperation, bucket: ProjectionMassBucket, prob: bigint): void {
        this.recordDetail(ACCOUNTING_STAGE.Projection, operation, bucket, prob);
    }

    /**
     * Scales and adds all mass from another accountant to this one.
     */
    public addScaled(other: ProbabilityMassAccountant, factor: bigint): void {
        for (let i = 0; i < BUCKET_COUNT; i++) {
            this.data[i]! += ProbUtils.scale(other.data[i]!, factor);
        }
    }

    /**
     * Returns the total active mass tracked (excluding recovered/diagnostic buckets).
     */
    public getTotalMass(): bigint {
        const d = this.data;
        // recoveredRounding (7) and recoveredSieved (8) are non-additive diagnostics.
        return d[0]! + d[1]! + d[2]! + d[3]! + d[4]! + d[5]! + d[6]!;
    }

    /**
     * Asserts that mass is conserved within the system (total matches PRECISION).
     */
    public assertConservation(): void {
        const total = this.getTotalMass();
        if (total !== PRECISION) {
            throw new Error(`Mass conservation violation: total mass is ${total}, expected ${PRECISION}`);
        }
    }

    public getBucketUnits(): MassBucketUnits {
        const d = this.data;
        return {
            resolved: d[0]!,
            clueIncompatible: d[1]!,
            pending: d[2]!,
            sieved: d[3]!,
            overflow: d[4]!,
            capped: d[5]!,
            rounding: d[6]!,
            recoveredRounding: d[7]!,
            recoveredSieved: d[8]!
        };
    }

    public toPublic(): MassAccountingBreakdown {
        const d = this.data;
        return {
            resolved: ProbUtils.toNumber(d[0]!),
            clueIncompatible: ProbUtils.toNumber(d[1]!),
            pending: ProbUtils.toNumber(d[2]!),
            sieved: ProbUtils.toNumber(d[3]!),
            overflow: ProbUtils.toNumber(d[4]!),
            capped: ProbUtils.toNumber(d[5]!),
            rounding: ProbUtils.toNumber(d[6]!),
            recoveredRounding: ProbUtils.toNumber(d[7]!),
            recoveredSieved: ProbUtils.toNumber(d[8]!),
            units: {
                resolved: d[0]!.toString(),
                clueIncompatible: d[1]!.toString(),
                pending: d[2]!.toString(),
                sieved: d[3]!.toString(),
                overflow: d[4]!.toString(),
                capped: d[5]!.toString(),
                rounding: d[6]!.toString(),
                recoveredRounding: d[7]!.toString(),
                recoveredSieved: d[8]!.toString()
            }
        };
    }

    public toPublicDetails(): MassAccountingDetails | undefined {
        if (!this.detailData) return undefined;

        const stages: Record<string, MassAccountingStageDetails> = {};
        const search = this.buildStageDetails(
            ACCOUNTING_STAGE.Search,
            SEARCH_OPERATION_LABELS,
            MASS_BUCKET_LABELS
        );
        if (search) stages['search'] = search;

        const projection = this.buildStageDetails(
            ACCOUNTING_STAGE.Projection,
            PROJECTION_OPERATION_LABELS,
            PROJECTION_BUCKET_LABELS
        );
        if (projection) stages['projection'] = projection;

        if (Object.keys(stages).length === 0) return undefined;
        return Object.freeze({ stages: Object.freeze(stages) });
    }

    /**
     * Returns the mass from generation paths that reached a valid leaf state.
     */
    public getResolvedMass(): bigint {
        return this.data[0]!;
    }

    /**
     * Returns active mass that is no longer pending frontier work.
     */
    public getClassifiedMass(): bigint {
        return this.getTotalMass() - this.data[BUCKET_INDEX.pending]!;
    }

    /**
     * Returns the mass that has been removed from the frontier by normal exploration.
     */
    public getExploredMass(): bigint {
        const d = this.data;
        return d[0]! + d[1]! + d[3]! + d[4]!;
    }

    /**
     * Returns the mass discovered but not yet expanded.
     */
    public getUnexploredMass(): bigint {
        return this.data[BUCKET_INDEX.pending]!;
    }

    /**
     * Returns the mass that was intentionally pruned or discarded due to technical limits.
     */
    public getDiscardedMass(): bigint {
        const d = this.data;
        return d[3]! + d[4]! + d[5]!;
    }

    public clone(): ProbabilityMassAccountant {
        const other = new ProbabilityMassAccountant();
        other.data.set(this.data);
        if (this.detailData) other.detailData = [...this.detailData];
        return other;
    }

    private recordDetail(stage: number, operation: number, bucket: number, delta: bigint): void {
        if (delta === 0n) return;
        const detailData = this.ensureDetailData();
        const index = detailIndex(stage, operation, bucket);
        detailData[index] = detailData[index]! + delta;
    }

    private ensureDetailData(): bigint[] {
        if (!this.detailData) {
            this.detailData = new Array<bigint>(
                ACCOUNTING_STAGE_COUNT * ACCOUNTING_DETAIL_OPERATION_COUNT * ACCOUNTING_DETAIL_BUCKET_COUNT
            ).fill(0n);
        }
        return this.detailData;
    }

    private buildStageDetails(
        stage: number,
        operationLabels: readonly string[],
        bucketLabels: readonly string[]
    ): MassAccountingStageDetails | undefined {
        const detailData = this.detailData;
        if (!detailData) return undefined;

        const stageBucketUnits: Record<string, bigint> = {};
        const operations: Record<string, MassAccountingOperationDetails> = {};

        for (let operation = 0; operation < operationLabels.length; operation++) {
            const operationBuckets: Record<string, MassAccountingDetailBucket> = {};

            for (let bucket = 0; bucket < bucketLabels.length; bucket++) {
                const units = detailData[detailIndex(stage, operation, bucket)] ?? 0n;
                if (units === 0n) continue;

                const bucketLabel = bucketLabels[bucket]!;
                stageBucketUnits[bucketLabel] = (stageBucketUnits[bucketLabel] ?? 0n) + units;
                operationBuckets[bucketLabel] = toDetailBucket(units);
            }

            if (Object.keys(operationBuckets).length > 0) {
                operations[operationLabels[operation]!] = Object.freeze({
                    buckets: Object.freeze(operationBuckets)
                });
            }
        }

        const buckets = toDetailBuckets(stageBucketUnits);
        if (Object.keys(buckets).length === 0 && Object.keys(operations).length === 0) return undefined;
        return Object.freeze({
            buckets: Object.freeze(buckets),
            operations: Object.freeze(operations)
        });
    }
}

export class SearchMassRecorder {
    public constructor(
        private readonly accountant: ProbabilityMassAccountant,
        private readonly operation: SearchMassOperation
    ) {}

    public record(bucket: SearchMassBucket, prob: bigint): void {
        this.accountant.recordSearch(this.operation, bucket, prob);
    }

    public subtract(bucket: SearchMassBucket, prob: bigint): void {
        this.accountant.subtractSearch(this.operation, bucket, prob);
    }
}

export class ProjectionMassRecorder {
    public constructor(
        private readonly accountant: ProbabilityMassAccountant,
        private readonly operation: ProjectionMassOperation
    ) {}

    public record(bucket: ProjectionMassBucket, prob: bigint): void {
        this.accountant.recordProjection(this.operation, bucket, prob);
    }
}

function detailIndex(stage: number, operation: number, bucket: number): number {
    return ((stage * ACCOUNTING_DETAIL_OPERATION_COUNT) + operation) * ACCOUNTING_DETAIL_BUCKET_COUNT + bucket;
}

function toDetailBuckets(unitsByBucket: Record<string, bigint>): Record<string, MassAccountingDetailBucket> {
    const buckets: Record<string, MassAccountingDetailBucket> = {};
    for (const [bucket, units] of Object.entries(unitsByBucket)) {
        if (units === 0n) continue;
        buckets[bucket] = toDetailBucket(units);
    }
    return buckets;
}

function toDetailBucket(units: bigint): MassAccountingDetailBucket {
    return Object.freeze({
        value: ProbUtils.toNumber(units),
        units: units.toString()
    });
}
