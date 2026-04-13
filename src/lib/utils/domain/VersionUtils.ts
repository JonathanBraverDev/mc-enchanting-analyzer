/**
 * Utility functions for version parsing and comparison.
 */
export const VersionUtils = {
    /**
     * Parses a version string into an array of numbers.
     */
    parse: (v: string): number[] => (v.match(/\d+/g) || []).map(Number),

    /**
     * Compares two version strings.
     */
    compare: (v1: string, v2: string): number => {
        const p1 = VersionUtils.parse(v1);
        const p2 = VersionUtils.parse(v2);
        const maxLen = Math.max(p1.length, p2.length);
        for (let i = 0; i < maxLen; i++) {
            const a = p1[i] || 0;
            const b = p2[i] || 0;
            if (a > b) return 1;
            if (a < b) return -1;
        }
        return 0;
    },

    /**
     * Checks if a version is within a specific range.
     */
    isInRange: (target: string, start?: string, end: string = "99.9"): boolean => {
        if (!start) return true;
        return VersionUtils.compare(target, start) >= 0 && VersionUtils.compare(target, end) <= 0;
    }
};
