import { CompactStats } from '../types/index.js';
import { EnchantInsights } from '../types/index.js';

export type WorkerRequest =
    | { type: "init"; id: number; payload: { version: string } }
    | { type: "getFullStats"; id: number; payload: {
        cat: string;
        xp: number;
        mat: string;
        guaranteedFirst: string | null;
        threshold: number;
        source?: string;
        useBestCache?: boolean;
        maxIterations?: number;
      }}
    | { type: "getModifiedLevelDist"; id: number; payload: { xp: number; enchantability: number } }
    | { type: "getEligibleListNumeric"; id: number; payload: { cat: string; level: number; mat: string; bitset?: bigint } };

export type WorkerResponse =
    | { type: "ready"; id: number; payload?: undefined }
    | { type: "result"; id: number; payload: { stats: CompactStats | any; human?: EnchantInsights } }
    | { type: "progress"; id: number; payload: { stats: CompactStats; human: EnchantInsights } }
    | { type: "error"; id: number; payload: string };
