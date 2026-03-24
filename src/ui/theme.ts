import { DATA } from '../data/index.js';
import { Registry } from '../core/registry.js';
import { RomanUtils } from '../utils/index.js';

/**
 * Manages UI colors and enchantment-specific styles.
 */
export const ThemeManager = {
    /**
     * Calculates a color for an enchantment based on its base name and rank.
     */
    getEnchantColor: (idOrName: string | number, registry: Registry): string => {
        let fullName = typeof idOrName === 'number' ? registry.getFullEnchantName(idOrName) : idOrName;
        const base = RomanUtils.getBaseName(fullName, registry.data.constants.ROMAN_MAP);
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
                return `hsl(${parts[0]}, ${parts[1]}%, ${parseInt(parts[2]) + boost}%)`;
            }
        }
        return color;
    }
};
