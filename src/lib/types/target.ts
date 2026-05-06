import type { PackedCombo } from '#types/engine.js';

export type TargetRankMode = 'atLeast';

export interface TargetRequirementInput {
  enchantment: string;
  rank: number;
  rankMode: TargetRankMode;
}

export interface PackedTargetRequirement {
  idAndRank: number;
  enchantmentId: number;
  rank: number;
  rankMode: TargetRankMode;
  label: string;
}

export interface TargetOptionView {
  enchantment: string;
  rank: number;
  label: string;
}

export interface TargetDiagnosticsView {
  labels: string[];
  matchShare: number;
  matchingComboCount: number;
  nearMissShare: number;
  nearMissComboCount: number;
  blockedShare: number;
  blockedComboCount: number;
}

export interface TargetAnalysisResult {
  matchMass: bigint;
  matchingComboCount: number;
  nearMissMass: bigint;
  nearMissComboCount: number;
  blockedMass: bigint;
  blockedComboCount: number;
  combos: Map<PackedCombo, bigint>;
}
