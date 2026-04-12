import { MassBookkeeping, MassAccounting } from '../types/mass.js';
import { ProbUtils } from '../utils/math/ProbUtils.js';

/**
 * Type of termination event that causes probability mass to be settled into a specific bucket.
 */
export type MassEventType = 'resolved' | 'pending' | 'sieved' | 'overflow' | 'capped' | 'rounding' | 'recoveredRounding' | 'recoveredSieved';

/**
 * Dedicated class for enchantment engine probability bookkeeping.
 * Uses High-Precision BigInt (1e12 scale) to track six distinct buckets of mass termination.
 * 
 * Bucket Definitions:
 * - Resolved: Success! Reached a natural leaf node.
 * - Pending: Uncertain. Still in the search queue.
 * - Sieved: Discarded below the resolution floor.
 * - Overflow: Discarded by technical limits (6-enchant limit).
 * - Capped: Discarded by engine limits (e.g. results limit or queue full).
 * - Rounding: Lost to integer math or precision.
 */
export class MassAccountant {
    private buckets: Record<MassEventType, bigint> = {
        resolved: 0n,
        pending: 0n,
        sieved: 0n,
        overflow: 0n,
        capped: 0n,
        rounding: 0n,
        recoveredRounding: 0n,
        recoveredSieved: 0n
    };

    constructor(initial?: MassBookkeeping) {
        if (initial) {
            this.buckets.resolved = initial.resolved;
            this.buckets.pending = initial.pending;
            this.buckets.sieved = initial.sieved;
            this.buckets.overflow = initial.overflow;
            this.buckets.capped = initial.capped;
            this.buckets.rounding = initial.rounding;
            this.buckets.recoveredRounding = initial.recoveredRounding || 0n;
            this.buckets.recoveredSieved = initial.recoveredSieved || 0n;
        }
    }

    public static fromPublic(publicAcc: MassAccounting): MassAccountant {
        return new MassAccountant({
            resolved: ProbUtils.toBigInt(publicAcc.resolved),
            pending: ProbUtils.toBigInt(publicAcc.pending),
            sieved: ProbUtils.toBigInt(publicAcc.sieved),
            overflow: ProbUtils.toBigInt(publicAcc.overflow),
            capped: ProbUtils.toBigInt(publicAcc.capped),
            rounding: ProbUtils.toBigInt(publicAcc.rounding),
            recoveredRounding: ProbUtils.toBigInt(publicAcc.recoveredRounding || 0),
            recoveredSieved: ProbUtils.toBigInt(publicAcc.recoveredSieved || 0),
        });
    }

    public record(type: MassEventType, prob: bigint): void {
        this.buckets[type] += prob;
    }

    public subtract(type: MassEventType, prob: bigint): void {
        this.buckets[type] -= prob;
    }

    public reset(type: MassEventType): void {
        this.buckets[type] = 0n;
    }

    /**
     * Scales all buckets of another accountant and adds them to this one.
     * Uses Banker's Rounding for statistically zero-drift conservation.
     */
    public addScaled(other: MassAccountant, factor: bigint): void {
        const b = other.buckets;
        for (const key in b) {
            const type = key as MassEventType;
            this.buckets[type] += ProbUtils.scale(b[type], factor);
        }
    }

    public getTotalMass(): bigint {
        const b = this.buckets;
        // Recovered buckets are diagnostic subsets, NOT additive to the total 100% mass.
        return b.resolved + b.pending + b.sieved + b.overflow + b.capped + b.rounding;
    }

    public copy(): MassAccountant {
        return new MassAccountant(this.getBookkeeping());
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

    /**
     * Aggregates multiple accountants into a single state.
     */
    public static aggregate(accountants: MassAccountant[]): MassAccountant {
        const result = new MassAccountant();
        for (const acc of accountants) {
            for (const key in acc.buckets) {
                const type = key as MassEventType;
                result.buckets[type] += acc.buckets[type];
            }
        }
        return result;
    }
}
