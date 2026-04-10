import { MassBookkeeping, MassAccounting } from '../types/mass.js';
import { ProbUtils } from '../utils/math/ProbUtils.js';

/**
 * Type of termination event that causes probability mass to be settled into a specific bucket.
 */
export type MassEventType = 'resolved' | 'pending' | 'sieved' | 'overflow' | 'capped' | 'rounding';

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
    private resolved: bigint = 0n;
    private pending: bigint = 0n;
    private sieved: bigint = 0n;
    private overflow: bigint = 0n;
    private capped: bigint = 0n;
    private rounding: bigint = 0n;

    constructor(initial?: MassBookkeeping) {
        if (initial) {
            this.resolved = initial.resolved;
            this.pending = initial.pending;
            this.sieved = initial.sieved;
            this.overflow = initial.overflow;
            this.capped = initial.capped;
            this.rounding = initial.rounding;
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
        });
    }

    public record(type: MassEventType, prob: bigint): void {
        switch (type) {
            case 'resolved': this.resolved += prob; break;
            case 'pending':  this.pending += prob;  break;
            case 'sieved':   this.sieved += prob;   break;
            case 'overflow': this.overflow += prob; break;
            case 'capped':   this.capped += prob;   break;
            case 'rounding': this.rounding += prob; break;
        }
    }

    public subtract(type: MassEventType, prob: bigint): void {
        switch (type) {
            case 'resolved': this.resolved -= prob; break;
            case 'pending':  this.pending -= prob;  break;
            case 'sieved':   this.sieved -= prob;   break;
            case 'overflow': this.overflow -= prob; break;
            case 'capped':   this.capped -= prob;   break;
            case 'rounding': this.rounding -= prob; break;
        }
    }

    public reset(type: MassEventType): void {
        switch (type) {
            case 'resolved': this.resolved = 0n; break;
            case 'pending':  this.pending = 0n;  break;
            case 'sieved':   this.sieved = 0n;   break;
            case 'overflow': this.overflow = 0n; break;
            case 'capped':   this.capped = 0n;   break;
            case 'rounding': this.rounding = 0n; break;
        }
    }

    /**
     * Scales all buckets of another accountant and adds them to this one.
     * Ensures internal probability conservation by attributing scaling remainder to rounding.
     */
    public addScaled(other: MassAccountant, factor: bigint): void {
        const b = other.getBookkeeping();
        const s = (val: bigint) => ProbUtils.scale(val, factor);

        const r = s(b.resolved);
        const p = s(b.pending);
        const v = s(b.sieved);
        const o = s(b.overflow);
        const c = s(b.capped);
        const n = s(b.rounding);

        const totalExpected = ProbUtils.scale(other.getTotalMass(), factor);
        const totalActual = r + p + v + o + c + n;
        const diff = totalExpected - totalActual;

        this.resolved += r;
        this.pending += p;
        this.sieved += v;
        this.overflow += o;
        this.capped += c;
        this.rounding += n + diff;
    }

    public getTotalMass(): bigint {
        return this.resolved + this.pending + this.sieved + this.overflow + this.capped + this.rounding;
    }

    public copy(): MassAccountant {
        return new MassAccountant(this.getBookkeeping());
    }

    public getBookkeeping(): MassBookkeeping {
        return {
            resolved: this.resolved,
            pending: this.pending,
            sieved: this.sieved,
            overflow: this.overflow,
            capped: this.capped,
            rounding: this.rounding
        };
    }

    public toPublic(): MassAccounting {
        return {
            resolved: ProbUtils.toNumber(this.resolved),
            pending: ProbUtils.toNumber(this.pending),
            sieved: ProbUtils.toNumber(this.sieved),
            overflow: ProbUtils.toNumber(this.overflow),
            capped: ProbUtils.toNumber(this.capped),
            rounding: ProbUtils.toNumber(this.rounding)
        };
    }

    /**
     * Aggregates multiple accountants into a single state.
     */
    public static aggregate(accountants: MassAccountant[]): MassAccountant {
        const result = new MassAccountant();
        for (const acc of accountants) {
            result.resolved += acc.resolved;
            result.pending += acc.pending;
            result.sieved += acc.sieved;
            result.overflow += acc.overflow;
            result.capped += acc.capped;
            result.rounding += acc.rounding;
        }
        return result;
    }
}
