import { CompactStats } from '../types/index.js';

export type WorkerRequest =
    | { type: "init"; id: number; payload: { version: string } }
    | { type: "getFullStats"; id: number; payload: {
        cat: string;
        xp: number;
        mat: string;
        guaranteedFirst: string | null;
        threshold: number;
        source?: string;
        maxIterations?: number;
      }};

export type WorkerResponse =
    | { type: "ready"; id: number; payload?: undefined }
    | { type: "result"; id: number; payload: { stats: CompactStats } }
    | { type: "progress"; id: number; payload: { stats: CompactStats } }
    | { type: "error"; id: number; payload: string };
