import { ProbabilityShare, TopInputSignature, RefinementLevelName, ChartInputSignature, PassId } from '#lib/types/protocol.js';

export interface NormalizationView {
  domain: 'resolved-mass' | 'clue-known-space';
  /** Absolute compatible clue mass when clue-conditioned; absent otherwise. */
  clue?: {
    knownSpace: ProbabilityShare;
  };
}

export interface AccountingView {
  resolved: ProbabilityShare;
  clueIncompatible: ProbabilityShare;
  pending: ProbabilityShare;
  sieved: ProbabilityShare;
  overflow: ProbabilityShare;
  capped: ProbabilityShare;
  rounding: ProbabilityShare;
}

export interface TopComboView {
  /** Display labels, e.g. ['Sharpness IV', 'Looting III']. */
  enchants: string[];
  share: ProbabilityShare;
  enchantCount: number;
  rankSum: number;
  tooltip?: string;
}

export interface TopEnchantShareView {
  enchantId: number;
  label: string;
  share: ProbabilityShare;
  tooltip?: string;
}

export interface TopRunView {
  input: TopInputSignature;
  refinementLevel: RefinementLevelName;
  clueConditioned: boolean;
  normalization: NormalizationView;
  accounting: AccountingView;
  combos: TopComboView[];
  enchants: TopEnchantShareView[];
}

export interface ChartPassView {
  refinementLevel: RefinementLevelName;
  label: string;
  order: number;
}

export interface ChartRunEnvelopeView {
  input: ChartInputSignature;
  maxXpLevel: number;
  refinement: ChartPassView[];
}

export interface ChartProgressView {
  passId: PassId;
  refinementLevel: RefinementLevelName;
  completedXpLevels: number;
  totalXpLevels: number;
}

export interface ChartBucketsView {
  /** Probability that an enchantment appears at any rank, keyed by enchant id. */
  anyByEnchantId: Record<number, ProbabilityShare>;
  /** Probability that a specific enchant/rank appears, keyed by packed idAndRank. */
  rankByIdAndRank: Record<number, ProbabilityShare>;
  /** Probability by number of enchantments on the result. */
  countBySize: Record<number, ProbabilityShare>;
}

export interface ChartCellView {
  xpLevel: number;
  refinementLevel: RefinementLevelName;
  clueConditioned: boolean;
  normalization: NormalizationView;
  accounting?: AccountingView;
  buckets: ChartBucketsView;
}
