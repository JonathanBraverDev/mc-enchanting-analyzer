import { DATA } from '#data/index.js';
import { RegistryState } from '#types/index.js';
import { 
  getEligibleMaterials, 
  getEnchantability, 
  getFullEnchantName, 
  getEligiblePool 
} from '#core/registry.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';

import { RegistryFactory } from '#core/factory.js';

/**
 * Lightweight service for the UI to retrieve metadata and constraints
 * without importing the full EnchantEngine or search services.
 */
export class UiMetadataService {
  private static distributionService = new ModifiedLevelDistributionService();
  private static registries = new Map<string, RegistryState>();

  /** Returns the list of supported Minecraft versions in reverse chronological order. */
  public static getVersions(): string[] {
    return Object.keys(DATA.versions).reverse();
  }

  /** Gets the registry state for a specific version. */
  public static getRegistry(version: string): RegistryState {
    let registry = this.registries.get(version);
    if (!registry) {
      registry = RegistryFactory.build(DATA, version);
      this.registries.set(version, registry);
    }
    return registry;
  }

  /** Gets the maximum XP level for a version. */
  public static getXpCap(version: string): number {
    return this.getRegistry(version).mechanics.xp_cap || 30;
  }

  /** Gets eligible materials for a version and category. */
  public static getEligibleMaterials(version: string, category: string): string[] {
    return getEligibleMaterials(this.getRegistry(version), category);
  }

  /** Gets the base enchantability for a version, material, and category. */
  public static getEnchantability(version: string, material: string, category: string): number {
    return getEnchantability(this.getRegistry(version), material, category);
  }

  /** 
   * Gets all possible enchantments that could appear in the clue slot.
   * Performs a lightweight modified-level distribution to find eligible pools.
   */
  public static getClueOptions(version: string, category: string, material: string, xpLevel: number): string[] {
    const registry = this.getRegistry(version);
    const ench = getEnchantability(registry, material, category);
    const dist = this.distributionService.getModifiedLevelDist(registry, xpLevel, ench);
    
    const allPossible = new Set<string>();
    for (const mlStr of Object.keys(dist)) {
      const ml = parseInt(mlStr);
      const pool = getEligiblePool(registry, category, ml);
      for (const p of pool) {
        allPossible.add(getFullEnchantName(registry, p));
      }
    }

    return Array.from(allPossible).sort();
  }
}
