import { MassAccountingBreakdown, MassBucketName, MassBucketUnits } from '#types/mass.js';
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
    projectionLoss: 7,
    recoveredRounding: 8,
    recoveredSieved: 9
};
const BUCKET_COUNT = 10;

/**
 * Encapsulated state tracker for probability mass units.
 * Ensures strict conservation invariants and provides diagnostic visibility.
 */
export class ProbabilityMassAccountant {
    private data: BigUint64Array;

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
            this.data[BUCKET_INDEX.projectionLoss] = initialMass.projectionLoss ?? 0n;
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
        // projectionLoss (7), recoveredRounding (8), and recoveredSieved (9) are non-additive diagnostics.
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
            projectionLoss: d[7]!,
            recoveredRounding: d[8]!,
            recoveredSieved: d[9]!
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
            ...(d[7]! > 0n ? { projectionLoss: ProbUtils.toNumber(d[7]!) } : {}),
            recoveredRounding: ProbUtils.toNumber(d[8]!),
            recoveredSieved: ProbUtils.toNumber(d[9]!),
            units: {
                resolved: d[0]!.toString(),
                clueIncompatible: d[1]!.toString(),
                pending: d[2]!.toString(),
                sieved: d[3]!.toString(),
                overflow: d[4]!.toString(),
                capped: d[5]!.toString(),
                rounding: d[6]!.toString(),
                ...(d[7]! > 0n ? { projectionLoss: d[7]!.toString() } : {}),
                recoveredRounding: d[8]!.toString(),
                recoveredSieved: d[9]!.toString()
            }
        };
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
        return this.data[2]!;
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
        return other;
    }
}
