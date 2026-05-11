import { ENGINE_LIMITS } from '#constants/engine.js';
import { CompactStats, EnchantStats } from '#types/index.js';

/**
 * Service for zero-copy binary serialization of statistics.
 */
export class SerializationService {
    /**
     * Serializes statistics into a CompactStats object for transfer.
     */
    public static serialize(stats: EnchantStats): { compact: CompactStats, transferables: ArrayBuffer[] } {
        const comboEntries = Object.entries(stats.combos);
        const comboKeys = new Float64Array(comboEntries.length);
        const comboProbs = new Float64Array(comboEntries.length);
        let ci = 0;
        for (const [key, prob] of comboEntries) {
            comboKeys[ci] = parseInt(key, 16);
            comboProbs[ci] = prob as number;
            ci++;
        }

        const rankEntries = Object.entries(stats.ranks);
        const rankKeys = new Uint32Array(rankEntries.length);
        const rankProbs = new Float64Array(rankEntries.length);
        let ri = 0;
        for (const [key, prob] of rankEntries) {
            rankKeys[ri] = Number(key);
            rankProbs[ri] = prob as number;
            ri++;
        }

        const anyEntries = Object.entries(stats.any);
        const anyKeys = new Uint32Array(anyEntries.length);
        const anyProbs = new Float64Array(anyEntries.length);
        let ai = 0;
        for (const [key, prob] of anyEntries) {
            anyKeys[ai] = Number(key);
            anyProbs[ai] = prob as number;
            ai++;
        }

        const clueEntries = Object.entries(stats.shownClueDistribution ?? {});
        const clueKeys = new Uint32Array(clueEntries.length);
        const clueProbs = new Float64Array(clueEntries.length);
        let cli = 0;
        for (const [key, prob] of clueEntries) {
            clueKeys[cli] = Number(key);
            clueProbs[cli] = prob as number;
            cli++;
        }

        const counts = new Float64Array(ENGINE_LIMITS.MAX_COUNT_STATS);
        for (let i = 0; i < ENGINE_LIMITS.MAX_COUNT_STATS; i++) counts[i] = (stats.count[i] || 0);

        const compact: CompactStats = {
            comboKeys, comboProbs,
            rankKeys, rankProbs,
            anyKeys, anyProbs,
            clueKeys, clueProbs,
            counts,
            accuracy: stats.accuracy,
            accounting: stats.accounting,
            clue: stats.clue,
            threshold: stats.threshold
        };

        return {
            compact,
            transferables: [
                comboKeys.buffer, comboProbs.buffer,
                rankKeys.buffer, rankProbs.buffer,
                anyKeys.buffer, anyProbs.buffer,
                clueKeys.buffer, clueProbs.buffer,
                counts.buffer
            ]
        };
    }

    /**
     * Reconstructs statistics from a CompactStats object.
     */
    public static deserialize(compact: CompactStats): EnchantStats {
        const stats: EnchantStats = {
            ranks: {}, any: {}, count: {}, combos: {}, shownClueDistribution: {},
            accuracy: compact.accuracy,
            accounting: compact.accounting,
            clue: compact.clue,
            threshold: compact.threshold
        };

        for (const [i, key] of compact.comboKeys.entries()) {
            const prob = compact.comboProbs[i];
            if (prob === undefined) continue;
            stats.combos[key.toString(16)] = prob;
        }
        for (const [i, key] of compact.rankKeys.entries()) {
            const prob = compact.rankProbs[i];
            if (prob === undefined) continue;
            stats.ranks[key] = prob;
        }
        for (const [i, key] of compact.anyKeys.entries()) {
            const prob = compact.anyProbs[i];
            if (prob === undefined) continue;
            stats.any[key] = prob;
        }
        for (const [i, key] of compact.clueKeys.entries()) {
            const prob = compact.clueProbs[i];
            if (prob === undefined) continue;
            stats.shownClueDistribution ??= {};
            stats.shownClueDistribution[key] = prob;
        }
        for (const [i, val] of compact.counts.entries()) {
            if (val > 0) stats.count[i] = val;
        }

        return stats;
    }
}
