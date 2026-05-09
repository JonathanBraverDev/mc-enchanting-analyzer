import type { ResultSortMode, TopComboView } from '#types/index.js';

export class TopComboSortService {
    public static sort(combos: readonly TopComboView[], sortMode: ResultSortMode | string = 'prob'): TopComboView[] {
        const sorted = [...combos];

        sorted.sort((a, b) => {
            if (sortMode === 'count') {
                return this.compareNumberDesc(a.enchantCount, b.enchantCount)
                    || this.compareNumberDesc(a.share, b.share)
                    || this.compareLabel(a, b);
            }

            if (sortMode === 'rank') {
                return this.compareNumberDesc(a.rankSum, b.rankSum)
                    || this.compareNumberDesc(a.share, b.share)
                    || this.compareLabel(a, b);
            }

            return this.compareNumberDesc(a.share, b.share)
                || this.compareLabel(a, b);
        });

        return sorted;
    }

    private static compareNumberDesc(a: number, b: number): number {
        return b - a;
    }

    private static compareLabel(a: TopComboView, b: TopComboView): number {
        return a.enchants.join('+').localeCompare(b.enchants.join('+'));
    }
}
