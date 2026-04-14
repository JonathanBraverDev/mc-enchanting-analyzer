import { CompactStats, ProgressUpdate } from '#types/index.js';

export type WorkerRequest =
    | { type: "init"; id: number; payload: { version: string } }
    | { type: "calculate"; id: number; payload: {
        cat: string;
        xp: number;
        mat: string;
        guaranteedFirst?: string | null;
        threshold?: bigint;
        maxIterations?: number;
        source?: string;
      }}
    | { type: "calculateProgressive"; id: number; payload: {
        cat: string; xp: number; mat: string; guaranteedFirst: string | null;
        source: string;
        tiers: Array<{ threshold: number; limit: number }>;
        summaryLimit?: number; resultsLimit?: number;
      }};

export type WorkerResponse =
    | { type: "ready"; id: number; payload?: undefined }
    | { type: "result"; id: number; payload: { stats: CompactStats } }
    | { type: "progress"; id: number; payload: { stats?: CompactStats; update?: ProgressUpdate } }
    | { type: "error"; id: number; payload: string };
