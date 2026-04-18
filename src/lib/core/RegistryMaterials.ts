import { EnchantmentData } from '#types/index.js';

/**
 * Service for material-specific logic and compatibility.
 */
export class MaterialService {
    /**
     * Returns a list of eligible materials for a given category, sorted and filtered.
     */
    public static getEligibleMaterials(data: EnchantmentData, cat: string, mergedMaterials: Set<string>): string[] {
        const itemSpecific = data.constants.ITEM_SPECIFIC_CATS;
        const isArmor = data.constants.ARMOR_CATS.includes(cat);
        const mats = isArmor ? data.material_values.armor : data.material_values.tools;
        
        if (itemSpecific.includes(cat) && mats[cat] && mergedMaterials.has(cat)) {
            return [cat];
        }

        const eligible = Object.keys(mats).filter(m => this.isMaterialCompatible(m, cat, itemSpecific, mergedMaterials));
        return this.sortMaterials(data, eligible);
    }

    private static isMaterialCompatible(mat: string, cat: string, itemCats: string[], mergedMaterials: Set<string>): boolean {
        if (!mergedMaterials.has(mat)) return false;
        if (mat === "turtle_shell") return cat === "helmet";
        if (itemCats.includes(mat)) return mat === cat;
        return true;
    }

    private static sortMaterials(data: EnchantmentData, mats: string[]): string[] {
        const priors = data.constants.MATERIAL_PRIORITY;
        return mats.sort((a, b) => {
            const ai = priors.indexOf(a), bi = priors.indexOf(b);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return a.localeCompare(b);
        });
    }

    /**
     * Gets the base enchantability for a material/category combination.
     */
    public static getEnchantability(data: EnchantmentData, mat: string, cat: string): number {
        if (cat === "book") return 1;
        const { armor, tools } = data.material_values;
        const isArmor = data.constants.ARMOR_CATS.includes(cat);
        const value = (isArmor ? armor[mat] : tools[mat]);
        if (value === undefined) throw new Error(`Unknown material "${mat}" for category "${cat}"`);
        return value;
    }
}
