import { CompactStats, ProgressUpdate } from '#types/index.js';

/**
 * Request messages for the enchanting analyzer worker.
 *
 * - **init**: Initialize the worker engine for a specific game version.
 * - **calculate**: Single-pass search for a fixed category/xp/material combo.
 * - **calculateProgressive**: Tiered refinement search with progress callbacks.
 * - **calculateConditioned**: Bayesian search conditioned on an observed clue.
 *
 * The `source` field allows multiple UI components to run concurrent searches
 * without interfering with each other (abort is per-source).
 */
export type WorkerRequest =
    | { type: "init"; id: number; payload: { version: string } }
    | { type: "calculate"; id: number; payload: {
        cat: string;
        xp: number;
        mat: string;
        clue?: string | null;
        threshold?: bigint;
        maxIterations?: number;
        source?: string;
      }}
    | { type: "calculateProgressive"; id: number; payload: {
        cat: string; xp: number; mat: string; clue?: string | null;
        source: string;
        tiers: Array<{ threshold: number; limit: number }>;
        summaryLimit?: number; resultsLimit?: number;
      }}
    | { type: "calculateConditioned"; id: number; payload: {
        cat: string; xp: number; mat: string; clue: string;
        source?: string;
        threshold?: number;
        summaryLimit?: number;
        resultsLimit?: number;
      }};

/**
 * Response messages from the worker.
 *
 * - **ready**: Worker initialized and ready for calculations.
 * - **result**: Final calculation results (correlates with a request id).
 * - **progress**: Intermediate progress update (for progressive/tiered searches).
 * - **error**: Calculation failed or was aborted.
 */
export type WorkerResponse =
    | { type: "ready"; id: number; payload?: undefined }
    | { type: "result"; id: number; payload: { stats: CompactStats } }
    | { type: "progress"; id: number; payload: { stats?: CompactStats; update?: ProgressUpdate } }
    | { type: "error"; id: number; payload: string };
