import { ENGINE_DEFAULTS } from '../core/config.js';
import { CompactStats } from './types.js';

/**
 * Service for zero-copy binary serialization of statistics.
 */
export class SerializationService {
    /**
     * Serializes statistics into a CompactStats object for transfer.
     */
    public static serialize(stats: any): { compact: CompactStats, transferables: ArrayBuffer[] } {
        const comboEntries = Object.entries(stats.combos);
        const comboKeys = new BigUint64Array(comboEntries.length);
        const comboProbs = new Float64Array(comboEntries.length);
        for (let i = 0; i < comboEntries.length; i++) {
            comboKeys[i] = BigInt("0x" + comboEntries[i][0]);
            comboProbs[i] = comboEntries[i][1] as number;
        }

        const rankEntries = Object.entries(stats.ranks);
        const rankKeys = new Uint32Array(rankEntries.length);
        const rankProbs = new Float64Array(rankEntries.length);
        for (let i = 0; i < rankEntries.length; i++) {
            rankKeys[i] = Number(rankEntries[i][0]);
            rankProbs[i] = rankEntries[i][1] as number;
        }

        const anyEntries = Object.entries(stats.any);
        const anyKeys = new Uint32Array(anyEntries.length);
        const anyProbs = new Float64Array(anyEntries.length);
        for (let i = 0; i < anyEntries.length; i++) {
            anyKeys[i] = Number(anyEntries[i][0]);
            anyProbs[i] = anyEntries[i][1] as number;
        }

        const counts = new Float64Array(ENGINE_DEFAULTS.MAX_COUNT_STATS);
        for (let i = 0; i < ENGINE_DEFAULTS.MAX_COUNT_STATS; i++) counts[i] = (stats.count[i] || 0);

        const compact: CompactStats = {
            comboKeys, comboProbs,
            rankKeys, rankProbs,
            anyKeys, anyProbs,
            counts, uncertainty: stats.uncertainty,
            pruned: stats.pruned
        };

        return {
            compact,
            transferables: [
                comboKeys.buffer, comboProbs.buffer,
                rankKeys.buffer, rankProbs.buffer,
                anyKeys.buffer, anyProbs.buffer,
                counts.buffer
            ]
        };
    }

    /**
     * Reconstructs statistics from a CompactStats object.
     */
    public static deserialize(compact: CompactStats): any {
        const stats: any = { ranks: {}, any: {}, count: {}, combos: {}, uncertainty: compact.uncertainty, pruned: compact.pruned };
        
        for (let i = 0; i < compact.comboKeys.length; i++) {
            stats.combos[compact.comboKeys[i].toString(16)] = compact.comboProbs[i];
        }
        for (let i = 0; i < compact.rankKeys.length; i++) {
            stats.ranks[compact.rankKeys[i]] = compact.rankProbs[i];
        }
        for (let i = 0; i < compact.anyKeys.length; i++) {
            stats.any[compact.anyKeys[i]] = compact.anyProbs[i];
        }
        for (let i = 0; i < compact.counts.length; i++) {
            if (compact.counts[i] > 0) stats.count[i] = compact.counts[i];
        }
        
        return stats;
    }
}
