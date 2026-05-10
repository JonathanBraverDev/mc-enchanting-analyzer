import { PRECISION } from '#utils/index.js';
import type { PackedCombo } from '#types/index.js';
import type { V7PendingFrontierEntry, V7SearchRunSnapshot } from '#lib/v7/search/SearchRun.js';
import type { MassAccountingBreakdown } from '#types/mass.js';

type UnitOverrides = Partial<Record<keyof NonNullable<MassAccountingBreakdown['units']>, bigint>>;

export function makeV7Snapshot(options: {
    results?: Map<PackedCombo, bigint>;
    pendingEntries?: readonly V7PendingFrontierEntry[];
    units?: UnitOverrides;
    iterations?: number;
} = {}): V7SearchRunSnapshot {
    const results = options.results ?? new Map<PackedCombo, bigint>();
    const pendingEntries = options.pendingEntries ?? [];
    const mass = makeMass(options.units);
    return Object.freeze({
        results,
        mass,
        iterations: options.iterations ?? 0,
        pendingCount: pendingEntries.length,
        largestPendingMass: pendingEntries.reduce((max, entry) => entry.mass > max ? entry.mass : max, 0n),
        pendingEntries: Object.freeze([...pendingEntries]),
        programCount: 1,
        seededLevelCount: 1,
        activeResidueCount: 0,
        activeResidueMass: 0n,
        fullyResolved: pendingEntries.length === 0
    });
}

export function makeV7PendingEntry(combo: PackedCombo, count: number, mass: bigint): V7PendingFrontierEntry {
    return { programId: 0, nodeId: 0 as any, combo, count, mass };
}

function makeMass(overrides: UnitOverrides = {}): MassAccountingBreakdown {
    const unitsBig = {
        resolved: overrides.resolved ?? 0n,
        clueIncompatible: overrides.clueIncompatible ?? 0n,
        pending: overrides.pending ?? 0n,
        sieved: overrides.sieved ?? 0n,
        overflow: overrides.overflow ?? 0n,
        capped: overrides.capped ?? 0n,
        rounding: overrides.rounding ?? 0n,
        recoveredRounding: overrides.recoveredRounding ?? 0n,
        recoveredSieved: overrides.recoveredSieved ?? 0n
    };

    return {
        resolved: Number(unitsBig.resolved) / Number(PRECISION),
        clueIncompatible: Number(unitsBig.clueIncompatible) / Number(PRECISION),
        pending: Number(unitsBig.pending) / Number(PRECISION),
        sieved: Number(unitsBig.sieved) / Number(PRECISION),
        overflow: Number(unitsBig.overflow) / Number(PRECISION),
        capped: Number(unitsBig.capped) / Number(PRECISION),
        rounding: Number(unitsBig.rounding) / Number(PRECISION),
        recoveredRounding: Number(unitsBig.recoveredRounding) / Number(PRECISION),
        recoveredSieved: Number(unitsBig.recoveredSieved) / Number(PRECISION),
        units: Object.fromEntries(Object.entries(unitsBig).map(([key, value]) => [key, value.toString()])) as NonNullable<MassAccountingBreakdown['units']>
    };
}
