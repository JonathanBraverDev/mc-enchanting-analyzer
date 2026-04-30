import { TopInputSignature, BaseInputSignature, RefinementLevelName } from './protocol.js';

export type SnapshotType = 'top' | 'chart-cell';

export interface ChartCellInputSignature extends BaseInputSignature {
  xpLevel: number;
}

export interface SnapshotRequest {
  snapshotType: SnapshotType;
  input: TopInputSignature | ChartCellInputSignature;
  refinementLevel: RefinementLevelName;
  clue: string | null;
  comboLimit?: number;
}
