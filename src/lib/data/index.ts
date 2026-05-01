import { EnchantmentData } from '#types/index.js';
import { RAW_DATA } from '#data/registry.js';

/**
 * Smart Data Loader (Lazy Resolution).
 * In standalone builds, we prefer the global ENCHANTING_DATA to avoid 3x duplication.
 * We use a Proxy to ensure that even if the UI initializes before the global data
 * is fully bound, we can still resolve it at the moment of first use.
 */
export const DATA: EnchantmentData = new Proxy({} as EnchantmentData, {
  get(_, prop) {
    // 1. Resolve target (Global or Local)
    let target = (typeof globalThis !== 'undefined' && (globalThis as any).ENCHANTING_DATA) || RAW_DATA;
    
    // 2. Unwrap ES Module if needed
    if (target && typeof target === 'object' && 'RAW_DATA' in target) {
      target = (target as any).RAW_DATA;
    }

    // 3. Return the requested property
    return (target as any)[prop];
  },
  getOwnPropertyDescriptor(_, prop) {
    let target = (typeof globalThis !== 'undefined' && (globalThis as any).ENCHANTING_DATA) || RAW_DATA;
    if (target && typeof target === 'object' && 'RAW_DATA' in target) {
      target = (target as any).RAW_DATA;
    }
    return Object.getOwnPropertyDescriptor(target, prop);
  },
  ownKeys() {
    let target = (typeof globalThis !== 'undefined' && (globalThis as any).ENCHANTING_DATA) || RAW_DATA;
    if (target && typeof target === 'object' && 'RAW_DATA' in target) {
      target = (target as any).RAW_DATA;
    }
    return Object.keys(target || {});
  }
});
