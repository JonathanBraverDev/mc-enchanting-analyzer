import { TopInputSignature, BaseInputSignature, RefinementLevelName } from '#lib/types/protocol.js';

export type SnapshotType = 'top' | 'chart-cell';

export interface ChartCellInputSignature extends BaseInputSignature {
  xpLevel: number;
}

export interface SnapshotRequest {
  snapshotType: SnapshotType;
  input: TopInputSignature | ChartCellInputSignature;
  refinementLevel: RefinementLevelName;
  clue: string | null;
  /** Maximum combo entries to include. Values above the normal export cap require `uncappedResults: true`. */
  comboLimit?: number;
  /** Explicitly allow every combo entry in presentation output. */
  uncappedResults?: boolean | undefined;
  includeCombos?: boolean | undefined;
}
