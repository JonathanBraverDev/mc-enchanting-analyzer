/**
 * Unified test data for Enchantment Analyzer test suites.
 * Centralized here to avoid hardcoded duplication across UI and integration tests.
 */
export const TEST_DATA = {
    VERSIONS: {
        MODERN: '1.21',
        LEGACY: '1.4.6',
        POST_NETHERITE: '1.16',
        POST_COPPER: '1.21.9',
        CLASSIC: '1.3.1',
        BOOK_MULTI_LIMIT: '1.7.2', // Threshold for multi-enchant books
        LAPIS_PIVOT: '1.8'
    },

    GOD_ARMOR: {
        START: '1.14',
        END: '1.14.3' // exclusive
    },

    ITEMS: {
        SWORD: 'sword',
        PICKAXE: 'pickaxe',
        BOOK: 'book',
        MACE: 'mace',
        SPEAR: 'spear',
        CHESTPLATE: 'chestplate',
        BOW: 'bow'
    },

    MATERIALS: {
        DIAMOND: 'diamond',
        BOOK: 'book',
        MACE: 'mace',
        NETHERITE: 'netherite',
        BOW: 'bow',
        GOLD: 'gold',
        COPPER: 'copper'
    },

    PAYLOADS: {
        BASE_SWORD: {
            category: 'sword',
            material: 'diamond',
            clue: null,
            xpLevel: 30,
            version: '1.21'
        },
        BASE_PICKAXE: {
            category: 'pickaxe',
            material: 'diamond',
            clue: null,
            xpLevel: 30,
            version: '1.21'
        },
        MODERN_BOOK: {
            category: 'book',
            material: 'book',
            clue: null,
            xpLevel: 30,
            version: '1.21' // Internal ref
        }
    },

    REGEX: {
        // Matches "(XP%)" or "Complete" in chart status
        CHART_PROGRESS: /\((9\d|100)%\)|Complete/,
    },

    THRESHOLDS: {
        ACCURACY_HIGH: 0.999,
        ACCURACY_STANDARD: 0.99,
        PROB_MIN: 0.0001
    }
};
