import { PRECISION } from '#utils/index.js';
import type { PackedCombo } from '#types/index.js';
import type { PendingFrontierEntry, SearchRunSnapshot } from '#lib/search/SearchRun.js';
import type { MassAccountingBreakdown } from '#types/mass.js';

type UnitOverrides = Partial<Record<keyof NonNullable<MassAccountingBreakdown['units']>, bigint>>;

export function makeSearchSnapshot(options: {
    results?: Map<PackedCombo, bigint>;
    pendingEntries?: readonly PendingFrontierEntry[];
    units?: UnitOverrides;
    iterations?: number;
} = {}): SearchRunSnapshot {
    const results = options.results ?? new Map<PackedCombo, bigint>();
    const pendingEntries = options.pendingEntries ?? [];
    const mass = makeMass(options.units);
    return Object.freeze({
        results,
        mass,
        iterations: options.iterations ?? 0,
        lastExpandedMass: 0n,
        pendingCount: pendingEntries.length,
        largestPendingMass: pendingEntries.reduce((max, entry) => entry.mass > max ? entry.mass : max, 0n),
        pendingEntries: Object.freeze([...pendingEntries]),
        graphCount: 1,
        seededLevelCount: 1,
        activeResidueCount: 0,
        activeResidueMass: 0n,
        fullyResolved: pendingEntries.length === 0,
        suffixMerging: {
            enabled: false,
            canonicalEntryCount: 0,
            hits: 0,
            misses: 0,
            mergedPendingMass: 0n,
            avoidedPendingEntries: 0
        }
    });
}

export function makePendingEntry(combo: PackedCombo, count: number, mass: bigint): PendingFrontierEntry {
    return { graphId: 0, nodeId: 0 as any, combo, count, mass };
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
        projectionLoss: overrides.projectionLoss ?? 0n,
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
        projectionLoss: Number(unitsBig.projectionLoss) / Number(PRECISION),
        recoveredRounding: Number(unitsBig.recoveredRounding) / Number(PRECISION),
        recoveredSieved: Number(unitsBig.recoveredSieved) / Number(PRECISION),
        units: Object.fromEntries(Object.entries(unitsBig).map(([key, value]) => [key, value.toString()])) as NonNullable<MassAccountingBreakdown['units']>
    };
}
