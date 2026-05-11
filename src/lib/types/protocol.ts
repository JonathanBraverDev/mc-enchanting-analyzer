import type { TargetRequirementInput } from '#lib/types/target.js';

export type WorkerKind = 'top' | 'chart';
export type RunId = string & { readonly __brand: 'RunId' };
export type PassId = string & { readonly __brand: 'PassId' };
export type RequestId = number;

export type RefinementLevelName = 'coarse' | 'standard' | 'deep' | 'ultra';
export type RunState = 'calculating' | 'done';

/** Unit interval share, 0.0 to 1.0. Avoid naming this Percent to prevent 0-100 ambiguity. */
export type ProbabilityShare = number;

export interface BaseInputSignature {
  version: string;
  item: string;
  material: string;
  clue: string | null;
  targets?: TargetRequirementInput[] | undefined;
}

export interface TopInputSignature extends BaseInputSignature {
  xpLevel: number;
}

export interface ChartInputSignature extends BaseInputSignature {}

// Requests

export type WorkerRequest =
  | InitRequest
  | TopRunStartRequest
  | ChartRunStartRequest
  | TopRunProjectRequest;

export interface InitRequest {
  type: 'init';
  requestId: RequestId;
  version: string;
  /** Standalone builds pass shared registry bootstrap data here to avoid bundling it into each worker. */
  bootstrapData?: any;
}

export interface TopRunStartRequest {
  type: 'topRunStart';
  requestId: RequestId;
  runId: RunId;
  input: TopInputSignature;
  refinementLevels: RefinementLevelName[];
  view?: {
    comboLimit?: number;
    uncappedResults?: boolean;
  };
}

export interface TopRunProjectRequest {
  type: 'topRunProject';
  requestId: RequestId;
  runId: RunId;
  input: TopInputSignature;
  refinementLevels: RefinementLevelName[];
  view?: {
    comboLimit?: number;
    uncappedResults?: boolean;
  };
}

export interface ChartRunStartRequest {
  type: 'chartRunStart';
  requestId: RequestId;
  runId: RunId;
  input: ChartInputSignature;
  refinementLevels: RefinementLevelName[];
}

// Responses

export type WorkerResponse =
  | WorkerReadyResponse
  | RunAcceptedResponse
  | TopUpdateResponse
  | ChartUpdateResponse
  | RunTerminalResponse
  | WorkerErrorResponse;

export interface WorkerReadyResponse {
  type: 'ready';
  requestId: RequestId;
  worker: WorkerKind;
  version: string;
}

import { ChartRunEnvelopeView, TopRunView, ChartProgressView, ChartCellView } from '#lib/types/views.js';

export interface RunAcceptedResponse {
  type: 'runAccepted';
  requestId: RequestId;
  worker: WorkerKind;
  runId: RunId;
  input: BaseInputSignature;
  state: 'calculating';
  message: 'worker-handoff';
  chart?: ChartRunEnvelopeView;
}

export interface TopUpdateResponse {
  type: 'topUpdate';
  worker: 'top';
  runId: RunId;
  refinementLevel: RefinementLevelName;
  view: TopRunView;
}

export interface ChartUpdateResponse {
  type: 'chartUpdate';
  worker: 'chart';
  runId: RunId;
  passId: PassId;
  refinementLevel: RefinementLevelName;
  progress: ChartProgressView;
  cell: ChartCellView;
}

export type RunStatus = 'done' | 'error' | 'cancelled' | 'superseded';

export interface RunTerminalResponse {
  type: 'terminal';
  worker: WorkerKind;
  runId: RunId;
  status: RunStatus;
  error?: string;
}

export interface WorkerErrorResponse {
  type: 'error';
  requestId?: RequestId;
  worker: WorkerKind;
  runId?: RunId;
  error: string;
}
