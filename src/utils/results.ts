import { ProbUtils } from './math.js';
import { ComboUtils } from './domain.js';
import type { NameResolver, CompactStats } from './types.js';
import { ENGINE_DEFAULTS } from '../config.js';

/**
 * Handles statistical transformations, humanization, and compact serialization.
 */
export class ResultProcessor {
    /**
     * Summarizes raw engine results into a CalculationStats-like object.
     */
    static summarize(combos: Map<bigint, bigint>, uncertainty: bigint): any {
        const stats: any = {
            ranks: {},
            any: {},
            count: {},
            combos: {},
            uncertainty: ProbUtils.toNumber(uncertainty)
        };

        for (const [packed, probBig] of combos) {
            const prob = ProbUtils.toNumber(probBig);
            stats.combos[packed.toString(16)] = prob;
            
            const ids = ComboUtils.unpack(packed);
            stats.count[ids.length] = (stats.count[ids.length] || 0) + prob;

            let seenBasesBitmask = 0n;
            for (const n of ids) {
                stats.ranks[n] = (stats.ranks[n] || 0) + prob;
                
                const baseId = n >> 8;
                if (!((seenBasesBitmask >> BigInt(baseId)) & 1n)) {
                    stats.any[baseId] = (stats.any[baseId] || 0) + prob;
                    seenBasesBitmask |= (1n << BigInt(baseId));
                }
            }
        }
        return stats;
    }

    /**
     * Converts raw statistics into a human-readable format.
     */
    static humanize(stats: any, resolver: NameResolver): any {
        const human: any = {
            ranks: {},
            any: {},
            count: { ...stats.count },
            combos: {},
            uncertainty: stats.uncertainty
        };

        for (const [idAndRank, prob] of Object.entries(stats.ranks)) {
            const name = resolver.getFullEnchantName(Number(idAndRank));
            human.ranks[name] = prob;
        }

        for (const [id, prob] of Object.entries(stats.any)) {
            const name = resolver.getEnchantName(Number(id));
            human.any[name] = prob;
        }

        for (const [packed, prob] of Object.entries(stats.combos)) {
            const ids = ComboUtils.unpack(BigInt("0x" + packed));
            const comboKey = ids.map(n => resolver.getFullEnchantName(n)).join("+");
            human.combos[comboKey] = prob;
        }

        return human;
    }

    /**
     * Serializes CalculationStats into a CompactStats object for zero-copy transfer.
     */
    static serialize(stats: any): { compact: CompactStats, transferables: ArrayBuffer[] } {
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
            counts, uncertainty: stats.uncertainty
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
     * Reconstructs CalculationStats from a CompactStats object.
     */
    static deserialize(compact: CompactStats): any {
        const stats: any = { ranks: {}, any: {}, count: {}, combos: {}, uncertainty: compact.uncertainty };
        
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
