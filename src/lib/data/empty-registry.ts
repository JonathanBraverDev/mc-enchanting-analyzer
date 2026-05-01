import { EnchantmentData } from '#types/index.js';

/**
 * Empty registry for standalone builds.
 * Used via esbuild --alias to prevent data duplication.
 */
export const RAW_DATA = {} as EnchantmentData;
