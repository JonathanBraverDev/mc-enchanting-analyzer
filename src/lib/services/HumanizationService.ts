import { ComboUtils } from '#utils/domain/ComboUtils.js';
import { RomanUtils } from '#utils/format/RomanUtils.js';
import type { EnchantInsights, ResultSortMode, CalculationStats, RegistryState, PackedCombo } from '#types/index.js';
import { getEnchantName, getFullEnchantName } from '#core/registry.js';

/**
 * Service for converting calculation statistics into human-readable insights.
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
            ...(stats.shownClueDistribution ? { shownClueDistribution: {} } : {}),
            accuracy: stats.accuracy,
            accounting: stats.accounting,
            clue: stats.clue
                ? {
                    name: getFullEnchantName(resolver, stats.clue.idAndRank),
                    knownSpace: stats.clue.knownSpace
                }
                : undefined
        };

        for (const [idAndRank, prob] of Object.entries(stats.ranks)) {
            const name = getFullEnchantName(resolver, Number(idAndRank));
            human.ranks[name] = prob as number;
        }

        for (const [id, prob] of Object.entries(stats.any)) {
            const name = getEnchantName(resolver, Number(id));
            human.any[name] = prob as number;
        }

        for (const [idAndRank, prob] of Object.entries(stats.shownClueDistribution ?? {})) {
            const name = getFullEnchantName(resolver, Number(idAndRank));
            human.shownClueDistribution![name] = prob as number;
        }

        const comboShares: Record<string, number> = {};
        for (const [packed, prob] of Object.entries(stats.combos)) {
            const ids = ComboUtils.unpack(parseInt(packed, 16) as PackedCombo, resolver.indexToEnchant);
            const comboKey = ids.map(n => getFullEnchantName(resolver, n)).join("+");
            comboShares[comboKey] = prob as number;
        }

        // Apply sorting
        const entries = Object.entries(comboShares);
        if (sortMode === 'prob') {
            entries.sort((a, b) => this.compareComboShares(a, b));
        } else if (sortMode === 'count') {
            entries.sort((a, b) => {
                const countA = a[0].split('+').length;
                const countB = b[0].split('+').length;
                return countB - countA || this.compareComboShares(a, b);
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
                return rankB - rankA || this.compareComboShares(a, b);
            });
        }

        for (const [key, prob] of entries) {
            human.combos[key] = prob;
        }

        return human;
    }

    private static compareComboShares(a: [string, number], b: [string, number]): number {
        const delta = b[1] - a[1];
        if (Math.abs(delta) > 1e-15) return delta;
        return a[0].localeCompare(b[0]);
    }
}
