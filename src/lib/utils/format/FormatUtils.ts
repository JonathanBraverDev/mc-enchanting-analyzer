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

export interface TinyProbabilityOdds {
    human: string;
    scientificText: string;
    scientificMantissa: string;
    scientificExponent: number;
    shouldFadeScientific: boolean;
}

/**
 * Utility for UI-specific formatting.
 */
export class UIUtils {
    private static readonly TINY_PROBABILITY_THRESHOLD = 0.001;
    private static readonly SCIENTIFIC_ODDS_THRESHOLD = 1e9;

    /**
     * Formats a probability as a percentage string.
     */
    static formatPercent(prob: number): string {
        return (prob * 100).toFixed(1) + "%";
    }

    /**
     * Returns whether a probability is small enough that percent notation stops being useful.
     */
    static shouldUseTinyProbabilityOdds(prob: number): boolean {
        return Number.isFinite(prob) && prob > 0 && prob < UIUtils.TINY_PROBABILITY_THRESHOLD;
    }

    /**
     * Formats a tiny probability as reciprocal odds in both human and scientific forms.
     */
    static formatTinyProbabilityOdds(prob: number): TinyProbabilityOdds {
        if (!UIUtils.shouldUseTinyProbabilityOdds(prob)) {
            throw new Error(`Probability ${prob} is not a positive tiny probability`);
        }

        const denominator = 1 / prob;
        const scientificExponent = Math.floor(Math.log10(denominator));
        const scientificMantissa = UIUtils.formatCompactNumber(denominator / Math.pow(10, scientificExponent), 3);

        return {
            human: `1 in ${UIUtils.formatNamedNumber(denominator)}`,
            scientificText: `1 in ${scientificMantissa} × 10^${scientificExponent}`,
            scientificMantissa,
            scientificExponent,
            shouldFadeScientific: prob <= 1 / UIUtils.SCIENTIFIC_ODDS_THRESHOLD,
        };
    }

    private static formatNamedNumber(value: number): string {
        const units: Array<[number, string]> = [
            [1e12, 'trillion'],
            [1e9, 'billion'],
            [1e6, 'million'],
            [1e3, 'thousand'],
        ];

        for (const [unitValue, unitName] of units) {
            if (value >= unitValue) {
                return `${UIUtils.formatCompactNumber(value / unitValue, 3)} ${unitName}`;
            }
        }

        return Math.round(value).toLocaleString('en-US');
    }

    private static formatCompactNumber(value: number, maxSignificantDigits: number): string {
        const ceiled = UIUtils.ceilToSignificantDigits(value, maxSignificantDigits);

        return ceiled.toLocaleString('en-US', {
            maximumSignificantDigits: maxSignificantDigits,
        });
    }

    private static ceilToSignificantDigits(value: number, significantDigits: number): number {
        if (!Number.isFinite(value) || value === 0) return value;

        const exponent = Math.floor(Math.log10(Math.abs(value)));
        const scale = Math.pow(10, significantDigits - 1 - exponent);
        const scaled = value * scale;
        const epsilon = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8;

        return Math.ceil(scaled - epsilon) / scale;
    }
}
