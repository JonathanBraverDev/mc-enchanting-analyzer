import type { EngineExitReason, PackedCombo, PackedEnchant } from '#types/index.js';
import type { MassAccountingBreakdown } from '#types/mass.js';

export type FlexNodeId = number & { readonly __brand: 'FlexNodeId' };
export type FlexProgramId = number & { readonly __brand: 'FlexProgramId' };

export interface FlexAlternative {
    readonly packedEnchant: PackedEnchant;
    readonly weight: number;
}

export interface FlexFixedEmission {
    readonly kind: 'fixed';
    readonly packedEnchant: PackedEnchant;
}

export interface FlexChoiceEmission {
    readonly kind: 'choice';
    readonly alternatives: readonly FlexAlternative[];
    readonly totalWeight: number;
}

export type FlexEmission = FlexFixedEmission | FlexChoiceEmission;
export type FlexProgram = readonly FlexEmission[];

export interface FlexNodeBase {
    readonly id: FlexNodeId;
    readonly programId: FlexProgramId;
    readonly count: number;
}

export interface SolidNode extends FlexNodeBase {
    readonly kind: 'solid';
}

export interface PlexNode extends FlexNodeBase {
    readonly kind: 'plex';
}

export type FlexNode = SolidNode | PlexNode;

export interface FlexEdge {
    readonly weight: number;
    readonly childId: FlexNodeId;
}

export type FlexTerminalReason = 'overflow' | null;

export interface FlexExpansion {
    readonly node: FlexNode;
    readonly probContinue: bigint;
    readonly totalWeight: number;
    readonly edges: readonly FlexEdge[];
    readonly terminalReason: FlexTerminalReason;
}

export interface FlexGraph {
    getExpansion(nodeId: FlexNodeId): FlexExpansion;
}

export interface FlexCheckpointRequest {
    readonly threshold?: number | bigint | undefined;
    readonly maxIterations?: number | undefined;
    readonly exhaustive?: boolean | undefined;
    readonly targetClassifiedMass?: number | bigint | undefined;
    /**
     * Internal forward-mass floor. Omit to use Flex's default system floor for bounded searches;
     * set to 0 for concrete-V7 parity diagnostics that must not sieve tail nodes early.
     */
    readonly probabilityFloor?: number | bigint | undefined;
    readonly signal?: AbortSignal | undefined;
    /** Async search yield cadence. Used by worker-facing execution so abort messages can be observed. */
    readonly yieldEveryIterations?: number | undefined;
}

export interface FlexPendingEntry {
    readonly graphId: number;
    readonly nodeId: FlexNodeId;
    readonly programId: FlexProgramId;
    readonly mass: bigint;
    readonly count: number;
    readonly nodeKind: FlexNode['kind'];
}

export interface FlexRunSnapshot {
    readonly results: ReadonlyMap<FlexProgramId, bigint>;
    readonly mass: MassAccountingBreakdown;
    readonly iterations: number;
    readonly lastExpandedMass: bigint;
    readonly pendingCount: number;
    readonly largestPendingMass: bigint;
    readonly pendingEntries: readonly FlexPendingEntry[];
    readonly graphCount: number;
    readonly activeResidueCount: number;
    readonly activeResidueMass: bigint;
    readonly fullyResolved: boolean;
    readonly exitReason: EngineExitReason | undefined;
}

export interface FlexProjectedResults {
    readonly results: ReadonlyMap<PackedCombo, bigint>;
    readonly projectionLoss: bigint;
    readonly clueIncompatible: bigint;
    readonly projectedMass: bigint;
    readonly sourceMass: bigint;
}

export interface FlexProjectedPendingEntry {
    readonly graphId: number;
    readonly nodeId: FlexNodeId;
    readonly mass: bigint;
    readonly combo: PackedCombo;
    readonly count: number;
}

export interface FlexProjectedPendingResults {
    readonly pendingEntries: readonly FlexProjectedPendingEntry[];
    readonly projectionLoss: bigint;
    readonly clueIncompatible: bigint;
    readonly projectedMass: bigint;
    readonly sourceMass: bigint;
}
