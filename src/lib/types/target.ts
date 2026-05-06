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
  tablePossibleAtLevel: boolean;
  matchShare: number;
  matchingComboCount: number;
  nearMissShare: number;
  nearMissComboCount: number;
  blockedShare: number;
  blockedComboCount: number;
}

export interface TargetClueRecommendationView {
  idAndRank: number;
  label: string;
  targetChance: number;
  clueShare: number;
  targetAndClueShare: number;
  anyBaselineChance: number;
  liftOverAnyBaseline: number;
  compatibleBaselineChance: number;
  liftOverCompatibleBaseline: number;
}

export interface TargetClueAdvisorView {
  recommendations: TargetClueRecommendationView[];
}

export interface TargetLevelClueRecommendationView extends TargetClueRecommendationView {
  xpLevel: number;
}

export interface TargetLevelClueAdvisorView {
  recommendations: TargetLevelClueRecommendationView[];
}

export interface ClueSignalRecommendationView {
  idAndRank: number;
  label: string;
  clueShare: number;
  averageModifiedLevel: number;
  baselineModifiedLevel: number;
  modifiedLevelLift: number;
}

export interface ClueSignalAdvisorView {
  recommendations: ClueSignalRecommendationView[];
}

export interface LevelClueSignalRecommendationView extends ClueSignalRecommendationView {
  xpLevel: number;
}

export interface LevelClueSignalAdvisorView {
  recommendations: LevelClueSignalRecommendationView[];
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
