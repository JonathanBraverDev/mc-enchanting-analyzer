import { ComboUtils } from '../utils/domain/ComboUtils.js';
import { RomanUtils } from '../utils/format/RomanUtils.js';
import type { EnchantInsights, ResultSortMode, CalculationStats, RegistryState } from '../types/index.js';
import { getEnchantName, getFullEnchantName } from '../core/registry.js';

/**
 * Service for converting raw statistics into human-readable insights.
 */
export class HumanizationService {
    /**
     * Converts statistics into a human-readable format with optional sorting.
     */
    public static humanize(
        stats: CalculationStats,
        resolver: RegistryState,
        sortMode: ResultSortMode = 'prob',
        romanMap?: Record<string, number>
    ): EnchantInsights {
        const human: EnchantInsights = {
            ranks: {},
            any: {},
            count: { ...stats.count },
            combos: {},
            accuracy: stats.accuracy,
            accounting: stats.accounting
        };

        for (const [idAndRank, prob] of Object.entries(stats.ranks)) {
            const name = getFullEnchantName(resolver, Number(idAndRank));
            human.ranks[name] = prob as number;
        }

        for (const [id, prob] of Object.entries(stats.any)) {
            const name = getEnchantName(resolver, Number(id));
            human.any[name] = prob as number;
        }

        const rawCombos: Record<string, number> = {};
        for (const [packed, prob] of Object.entries(stats.combos)) {
            const ids = ComboUtils.unpack(parseInt(packed, 16), resolver.indexToEnchant);
            const comboKey = ids.map(n => getFullEnchantName(resolver, n)).join("+");
            rawCombos[comboKey] = prob as number;
        }

        // Apply sorting
        const entries = Object.entries(rawCombos);
        if (sortMode === 'prob') {
            entries.sort((a, b) => b[1] - a[1]);
        } else if (sortMode === 'count') {
            entries.sort((a, b) => {
                const countA = a[0].split('+').length;
                const countB = b[0].split('+').length;
                return countB - countA || b[1] - a[1];
            });
        } else if (sortMode === 'rank' && romanMap) {
            const getRankSum = (s: string) => {
                return s.split('+').reduce((sum, e) => {
                    const roman = e.trim().split(' ').pop() || "";
                    return sum + RomanUtils.getRomanValue(roman, romanMap);
                }, 0);
            };
            entries.sort((a, b) => {
                const rankA = getRankSum(a[0]);
                const rankB = getRankSum(b[0]);
                return rankB - rankA || b[1] - a[1];
            });
        }

        for (const [key, prob] of entries) {
            human.combos[key] = prob;
        }

        return human;
    }
}
