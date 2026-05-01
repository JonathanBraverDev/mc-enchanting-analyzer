import { MassBookkeeping, MassAccounting, MassEventType } from '#types/mass.js';
import { ProbUtils, PRECISION } from '#utils/index.js';

/**
 * Internal index mapping for probability mass buckets.
 */
const BUCKET_INDEX: Record<MassEventType, number> = {
    resolved: 0,
    pending: 1,
    sieved: 2,
    overflow: 3,
    capped: 4,
    rounding: 5,
    recoveredRounding: 6,
    recoveredSieved: 7,
    clueKnownSpace: 8
};
const BUCKET_COUNT = 9;

/**
 * Encapsulated state tracker for probability mass units.
 * Ensures strict conservation invariants and provides diagnostic visibility.
 */
export class ProbabilityMassAccountant {
    private data: BigUint64Array;

    constructor(initialMass?: MassBookkeeping) {
        this.data = new BigUint64Array(BUCKET_COUNT);
        if (initialMass) {
            this.data[BUCKET_INDEX.resolved] = initialMass.resolved;
            this.data[BUCKET_INDEX.pending] = initialMass.pending;
            this.data[BUCKET_INDEX.sieved] = initialMass.sieved;
            this.data[BUCKET_INDEX.overflow] = initialMass.overflow;
            this.data[BUCKET_INDEX.capped] = initialMass.capped;
            this.data[BUCKET_INDEX.rounding] = initialMass.rounding;
            this.data[BUCKET_INDEX.recoveredRounding] = initialMass.recoveredRounding;
            this.data[BUCKET_INDEX.recoveredSieved] = initialMass.recoveredSieved;
            this.data[BUCKET_INDEX.clueKnownSpace] = initialMass.clueKnownSpace;
        }
    }

    /**
     * Records a positive mass event in the specified bucket.
     */
    public record(type: MassEventType, prob: bigint): void {
        this.data[BUCKET_INDEX[type]!]! += prob;
    }

    /**
     * Subtracts mass from the specified bucket.
     */
    public subtract(type: MassEventType, prob: bigint): void {
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
        // recoveredRounding (6), recoveredSieved (7), and clueKnownSpace (8) are diagnostic
        return d[0]! + d[1]! + d[2]! + d[3]! + d[4]! + d[5]!;
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

    public getBookkeeping(): MassBookkeeping {
        const d = this.data;
        return {
            resolved: d[0]!,
            pending: d[1]!,
            sieved: d[2]!,
            overflow: d[3]!,
            capped: d[4]!,
            rounding: d[5]!,
            recoveredRounding: d[6]!,
            recoveredSieved: d[7]!,
            clueKnownSpace: d[8]!
        };
    }

    public toPublic(): MassAccounting {
        const d = this.data;
        return {
            resolved: ProbUtils.toNumber(d[0]!),
            pending: ProbUtils.toNumber(d[1]!),
            sieved: ProbUtils.toNumber(d[2]!),
            overflow: ProbUtils.toNumber(d[3]!),
            capped: ProbUtils.toNumber(d[4]!),
            rounding: ProbUtils.toNumber(d[5]!),
            recoveredRounding: ProbUtils.toNumber(d[6]!),
            recoveredSieved: ProbUtils.toNumber(d[7]!),
            clueKnownSpace: ProbUtils.toNumber(d[8]!),
            units: {
                resolved: d[0]!.toString(),
                pending: d[1]!.toString(),
                sieved: d[2]!.toString(),
                overflow: d[3]!.toString(),
                capped: d[4]!.toString(),
                rounding: d[5]!.toString(),
                recoveredRounding: d[6]!.toString(),
                recoveredSieved: d[7]!.toString(),
                clueKnownSpace: d[8]!.toString()
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
     * Returns the mass from frontiers that were discovered but not yet expanded.
     */
    public getUnexploredMass(): bigint {
        return this.data[1]!;
    }

    /**
     * Returns the mass that was intentionally pruned or discarded due to technical limits.
     */
    public getDiscardedMass(): bigint {
        const d = this.data;
        return d[2]! + d[3]! + d[4]!;
    }

    public clone(): ProbabilityMassAccountant {
        const other = new ProbabilityMassAccountant();
        other.data.set(this.data);
        return other;
    }
}
