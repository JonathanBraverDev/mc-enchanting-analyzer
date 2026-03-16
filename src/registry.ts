import { EnchantmentData, VersionManifest, VersionMechanics } from './types.js';
import { VersionUtils } from './utils.js';

/**
 * Handles version-specific data, enchantment registry, and material eligibility.
 */
export class Registry {
    public version: string;
    public data: EnchantmentData;
    public mechanics: VersionMechanics = {};
    public mergedItems: { [category: string]: string[] } = {};
    public mergedOverrides: { [enchantment: string]: any } = {};
    public resolvedRegistry: { [enchantment: string]: any } = {};
    public mergedMaterials = new Set<string>();
    public multiEnchantBooks: boolean = true;
    
    public idMap = new Map<string, number>();
    public revIdMap: string[] = [];
    public conflictBitsets: BigUint64Array = new BigUint64Array(0);
    public weightMap: Uint32Array = new Uint32Array(0);

    constructor(data: EnchantmentData, version: string) {
        this.data = data;
        this.version = version;
        this.setupContext();
    }

    private setupContext(): void {
        const { versions, enchantment_groups } = this.data;
        let curr = this.version;

        // Resolve version if it's a sub-version not explicitly in the data
        if (!versions[curr]) {
            const sorted = Object.keys(versions).sort(VersionUtils.compare);
            for (const v of sorted) {
                if (VersionUtils.compare(this.version, v) >= 0) curr = v;
            }
        }

        const chain: string[] = [];
        let temp: string | undefined = curr;
        while (temp) {
            chain.unshift(temp);
            temp = versions[temp]?.extends;
        }

        // Apply inheritance chain
        for (const vName of chain) {
            const manifest = versions[vName] as VersionManifest;
            if (!manifest) continue;

            if (manifest.item_enchantments) {
                for (const [cat, content] of Object.entries(manifest.item_enchantments)) {
                    const resolved = content.flatMap(item => enchantment_groups[item] || [item]);
                    this.mergedItems[cat] = [...new Set(resolved)];
                }
            }

            Object.assign(this.mechanics, manifest.mechanics || {});
            if (manifest.multi_enchant_books !== undefined) {
                this.multiEnchantBooks = manifest.multi_enchant_books;
            }
            
            if (manifest.overrides) {
                for (const [ench, props] of Object.entries(manifest.overrides)) {
                    this.mergedOverrides[ench] = Object.assign(this.mergedOverrides[ench] || {}, props);
                }
            }

            if (manifest.materials) {
                manifest.materials.forEach(m => this.mergedMaterials.add(m));
            }
        }

        // Finalize Registry
        const allEnchNames = Object.keys(this.data.global_enchantments);
        this.revIdMap = allEnchNames;
        allEnchNames.forEach((name, i) => this.idMap.set(name, i));
        
        this.conflictBitsets = new BigUint64Array(allEnchNames.length);
        this.weightMap = new Uint32Array(allEnchNames.length);

        for (let i = 0; i < allEnchNames.length; i++) {
            const name = allEnchNames[i];
            const props = Object.assign({}, this.data.global_enchantments[name], this.mergedOverrides[name] || {});
            this.resolvedRegistry[name] = props;
            this.weightMap[i] = props.weight;
            
            let bitset = 0n;
            if (props.conflicts) {
                for (const cName of props.conflicts) {
                    const cId = this.idMap.get(cName);
                    if (cId !== undefined) bitset |= (1n << BigInt(cId));
                }
            }
            this.conflictBitsets[i] = bitset;
        }
    }

    public getEligibleMaterials(cat: string): string[] {
        const isArmor = this.data.constants.ARMOR_CATS.includes(cat);
        const mats = isArmor ? this.data.material_values.armor : this.data.material_values.tools;
        const itemCats = this.data.constants.ITEM_SPECIFIC_CATS;
        
        let eligibleKeys = Object.keys(mats).filter(m => {
            if (!this.mergedMaterials.has(m)) return false;
            
            // Fix turtle_shell restriction: It's only for helmets.
            if (m === "turtle_shell") return cat === "helmet";
            
            return !itemCats.includes(m) || m === cat;
        });

        if (itemCats.includes(cat) && mats[cat] && cat !== "turtle_shell" && this.mergedMaterials.has(cat)) {
            eligibleKeys = [cat];
        }

        return eligibleKeys.sort((a, b) => {
            const priors = this.data.constants.MATERIAL_PRIORITY;
            const ai = priors.indexOf(a), bi = priors.indexOf(b);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return a.localeCompare(b);
        });
    }

    public getEnchantability(mat: string, cat: string): number {
        if (cat === "book") return 1;
        const { armor, tools } = this.data.material_values;
        const isArmor = this.data.constants.ARMOR_CATS.includes(cat);
        return (isArmor ? armor[mat] : tools[mat]) || 10;
    }
}
