import { UI_CONSTANTS } from '#constants/engine.js';

/**
 * Utility for string formatting.
 */
export class StringUtils {
    /**
     * Converts a snake_case slug to Title Case.
     */
    static toTitleCase(slug: string): string {
        return slug.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
}

/**
 * Utility for UI-specific formatting.
 */
export class UIUtils {
    /**
     * Formats a probability as a percentage string.
     */
    static formatPercent(prob: number): string {
        return (prob * 100).toFixed(UI_CONSTANTS.PERCENT_DECIMAL_PLACES) + "%";
    }
}
