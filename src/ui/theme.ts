import { DATA } from '#data/index.js';
import { getFullEnchantName } from '#core/registry.js';
import { RegistryState } from '#types/index.js';
import { RomanUtils } from '#utils/index.js';

const RANK_LINE_DASHES: Record<number, number[]> = {
    1: [],
    2: [10, 5],
    3: [4, 4],
    4: [10, 4, 2, 4],
    5: [14, 3, 3, 3]
};

interface RankLineStyle {
    color: string;
    borderDash: number[];
    borderWidth: number;
}

/**
 * Manages UI colors and enchantment-specific styles.
 */
export const ThemeManager = {
    /**
     * Calculates a color for an enchantment based on its base name and rank.
     */
    getEnchantColor: (idOrName: string | number, registry: RegistryState): string => {
        let fullName = typeof idOrName === 'number' ? getFullEnchantName(registry, idOrName) : idOrName;
        const base = RomanUtils.getBaseName(fullName, registry.romanMap);
        let color = DATA.cosmetics.ENCHANT_COLORS[base];

        if (!color) {
            let hash = 0;
            for (let i = 0; i < base.length; i++) hash = base.charCodeAt(i) + ((hash << 5) - hash);
            color = `hsl(${Math.abs(hash) % 360}, 65%, 60%)`;
        }

        const rankPart = fullName.split(' ').pop() || "";
        const boost = DATA.cosmetics.RANK_LIGHTNESS_BOOST[rankPart] || 0;

        if (color.startsWith('hsl')) {
            const parts = color.match(/\d+/g);
            if (parts && parts.length >= 3) {
                const [h = '', s = '', l = ''] = parts;
                return `hsl(${h}, ${s}%, ${parseInt(l) + boost}%)`;
            }
        }
        return color;
    },

    /**
     * Returns color and stroke style for a specific enchantment rank.
     *
     * Rank charts use a constant pattern vocabulary: rank I is the baseline
     * solid line, and higher ranks progress through increasingly distinctive
     * dash patterns without making line width dominate crowded charts.
     */
    getRankLineStyle: (idOrName: string | number, registry: RegistryState): RankLineStyle => {
        const fullName = typeof idOrName === 'number' ? getFullEnchantName(registry, idOrName) : idOrName;
        const rank = typeof idOrName === 'number'
            ? idOrName & 0xFF
            : registry.data.constants.ROMAN_MAP[fullName.split(' ').pop() || ''] || 1;

        return {
            color: ThemeManager.getEnchantColor(idOrName, registry),
            borderDash: RANK_LINE_DASHES[rank] || RANK_LINE_DASHES[5] || [],
            borderWidth: 2
        };
    }
};
