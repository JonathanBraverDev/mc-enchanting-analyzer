import { MassBookkeeping, MassAccounting, MassEventType } from '../../types/mass.js';
import { ProbUtils, PRECISION } from '../../utils/index.js';

/**
 * Encapsulated state tracker for probability mass units.
 * Ensures strict conservation invariants and provides diagnostic visibility.
 */
export class MassAccountant {
    private buckets: Record<MassEventType, bigint>;

    constructor(initialMass?: MassBookkeeping) {
        this.buckets = initialMass ? { ...initialMass } : {
            resolved: 0n,
            pending: 0n,
            sieved: 0n,
            overflow: 0n,
            capped: 0n,
            rounding: 0n,
            recoveredRounding: 0n,
            recoveredSieved: 0n
        };
    }

    /**
     * Records a positive mass event in the specified bucket.
     */
    public record(type: MassEventType, prob: bigint): void {
        this.buckets[type] += prob;
    }

    /**
     * Subtracts mass from the specified bucket.
     */
    public subtract(type: MassEventType, prob: bigint): void {
        this.buckets[type] -= prob;
    }

    /**
     * Scales and adds all mass from another accountant to this one.
     */
    public addScaled(other: MassAccountant, factor: bigint): void {
        const b = other.buckets;
        for (const key in b) {
            const type = key as MassEventType;
            this.buckets[type] += ProbUtils.scale(b[type], factor);
        }
    }

    /**
     * Returns the total active mass tracked (excluding recovered/diagnostic buckets).
     */
    public getTotalMass(): bigint {
        const b = this.buckets;
        // recoveredRounding and recoveredSieved are subsets of rounding and sieved respectively
        return b.resolved + b.pending + b.sieved + b.overflow + b.capped + b.rounding;
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
        return { ...this.buckets };
    }

    public toPublic(): MassAccounting {
        const b = this.buckets;
        return {
            resolved: ProbUtils.toNumber(b.resolved),
            pending: ProbUtils.toNumber(b.pending),
            sieved: ProbUtils.toNumber(b.sieved),
            overflow: ProbUtils.toNumber(b.overflow),
            capped: ProbUtils.toNumber(b.capped),
            rounding: ProbUtils.toNumber(b.rounding),
            recoveredRounding: ProbUtils.toNumber(b.recoveredRounding),
            recoveredSieved: ProbUtils.toNumber(b.recoveredSieved),
            units: {
                resolved: b.resolved.toString(),
                pending: b.pending.toString(),
                sieved: b.sieved.toString(),
                overflow: b.overflow.toString(),
                capped: b.capped.toString(),
                rounding: b.rounding.toString(),
                recoveredRounding: b.recoveredRounding.toString(),
                recoveredSieved: b.recoveredSieved.toString()
            }
        };
    }

    public clone(): MassAccountant {
        return new MassAccountant(this.getBookkeeping());
    }
}
