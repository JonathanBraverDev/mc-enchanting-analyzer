import { EnchantmentData, VersionManifest, VersionMechanics, Enchantment, ResolvedRegistry, MergedItems, MergedOverrides } from './types.js';
import { VersionUtils, LRUCache, PackedEnchant } from '../utils/index.js';
import { ENGINE_DEFAULTS } from './config.js';

/**
 * Handles version-specific data, enchantment registry, and material eligibility.
 */
export class Registry {
    public version: string;
    public data: EnchantmentData;
    public mechanics: VersionMechanics = {};
    public mergedItems: MergedItems = {};
    public mergedOverrides: MergedOverrides = {};
    public resolvedRegistry: ResolvedRegistry = {};
    public mergedMaterials = new Set<string>();
    public multiEnchantBooks: boolean = true;
    
    private versionPool: Map<string, string[]> = new Map();
    
    private poolCache = new LRUCache<string, PackedEnchant[]>(200);
    
    public idMap = new Map<string, number>();
    public revIdMap: string[] = [];
    public catIdMap = new Map<string, number>();
    public matIdMap = new Map<string, number>();
    public conflictBitsets: BigUint64Array = new BigUint64Array(0);
    public weightMap: Uint32Array = new Uint32Array(0);
    public sortedRanks: [string, number][] = [];

    constructor(data: EnchantmentData, version: string) {
        this.data = data;
        this.version = version;
        this.setupContext();
    }

    private setupContext(): void {
        const curr = this.resolveVersion(this.version);
        const chain = this.getInheritanceChain(curr);

        // Apply inheritance chain
        for (const vName of chain) {
            const manifest = this.data.versions[vName] as VersionManifest;
            if (manifest) this.applyVersionManifest(manifest);
        }

        this.finalizeEnchantmentRegistry();
        this.initializeIdMaps();
        this.filterMergedPools();
        this.initializeVersionPool();
    }

    private initializeVersionPool(): void {
        for (const [cat, pool] of Object.entries(this.mergedItems)) {
            const filtered = pool.filter(name => {
                const props = this.resolvedRegistry[name];
                return VersionUtils.isInRange(this.version, props.valid_from, props.valid_to);
            });
            this.versionPool.set(cat, filtered);
        }
    }

    private resolveVersion(v: string): string {
        if (this.data.versions[v]) return v;
        const sorted = Object.keys(this.data.versions).sort(VersionUtils.compare);
        let resolved = sorted[0];
        for (const ver of sorted) {
            if (VersionUtils.compare(v, ver) >= 0) resolved = ver;
        }
        return resolved;
    }

    private getInheritanceChain(v: string): string[] {
        const chain: string[] = [];
        let temp: string | undefined = v;
        while (temp) {
            chain.unshift(temp);
            temp = this.data.versions[temp]?.extends;
        }
        return chain;
    }

    private applyVersionManifest(manifest: VersionManifest): void {
        if (manifest.item_enchantments) {
            for (const [cat, content] of Object.entries(manifest.item_enchantments)) {
                const resolved = content.flatMap(item => this.data.enchantment_groups[item] || [item]);
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

    private finalizeEnchantmentRegistry(): void {
        const allEnchNames = Object.keys(this.data.global_enchantments);
        this.revIdMap = allEnchNames;
        allEnchNames.forEach((name, i) => this.idMap.set(name, i));
        
        this.conflictBitsets = new BigUint64Array(allEnchNames.length);
        this.weightMap = new Uint32Array(allEnchNames.length);

        for (let i = 0; i < allEnchNames.length; i++) {
            const name = allEnchNames[i];
            const props = Object.assign({}, this.data.global_enchantments[name], this.mergedOverrides[name] || {}) as Enchantment;
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

        const romanMap = this.data.constants.ROMAN_MAP;
        this.sortedRanks = Object.entries(romanMap).sort((a, b) => b[1] - a[1]);
    }

    private initializeIdMaps(): void {
        const addId = (map: Map<string, number>, key: string) => {
            if (!map.has(key)) map.set(key, map.size);
        };

        Object.keys(this.data.enchantment_groups).forEach(cat => addId(this.catIdMap, cat));
        
        const matValues = this.data.material_values;
        [...Object.keys(matValues.tools), ...Object.keys(matValues.armor)].forEach(mat => addId(this.matIdMap, mat));

        Object.values(this.data.versions).forEach(v => {
            if (v.item_enchantments) {
                Object.keys(v.item_enchantments).forEach(cat => {
                    addId(this.catIdMap, cat);
                    addId(this.matIdMap, cat);
                });
            }
        });

        this.data.constants.ITEM_SPECIFIC_CATS.forEach(cat => {
            addId(this.catIdMap, cat);
            addId(this.matIdMap, cat);
        });
    }

    private filterMergedPools(): void {
        for (const cat of Object.keys(this.mergedItems)) {
            this.mergedItems[cat] = this.mergedItems[cat].filter(name => {
                const props = this.resolvedRegistry[name];
                return VersionUtils.isInRange(this.version, props.valid_from, props.valid_to);
            });
        }
    }

    public getEligibleMaterials(cat: string): string[] {
        const itemSpecific = this.data.constants.ITEM_SPECIFIC_CATS;
        const isArmor = this.data.constants.ARMOR_CATS.includes(cat);
        const mats = isArmor ? this.data.material_values.armor : this.data.material_values.tools;
        
        // Items with their own material (like 'mace', 'brush') are locked to that material
        if (itemSpecific.includes(cat) && mats[cat] && this.mergedMaterials.has(cat)) {
            return [cat];
        }

        const eligible = Object.keys(mats).filter(m => this.isMaterialCompatible(m, cat, itemSpecific));
        return this.sortMaterials(eligible);
    }

    private isMaterialCompatible(mat: string, cat: string, itemCats: string[]): boolean {
        if (!this.mergedMaterials.has(mat)) return false;
        
        // Turtle shell is a special case: only for helmets
        if (mat === "turtle_shell") return cat === "helmet";
        
        // Item-specific categories (like 'brush') only allow their own material
        if (itemCats.includes(mat)) return mat === cat;
        
        return true;
    }

    private sortMaterials(mats: string[]): string[] {
        const priors = this.data.constants.MATERIAL_PRIORITY;
        return mats.sort((a, b) => {
            const ai = priors.indexOf(a), bi = priors.indexOf(b);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return a.localeCompare(b);
        });
    }

    public getEnchantName(id: number): string {
        return this.revIdMap[id] || "Unknown";
    }

    public getRankRoman(rank: number): string {
        const romanMap = this.data.constants.ROMAN_MAP;
        for (const [k, v] of Object.entries(romanMap)) {
            if (v === rank) return k;
        }
        return rank.toString();
    }

    public getCategoryId(cat: string): number {
        return this.catIdMap.get(cat) ?? ENGINE_DEFAULTS.UNKNOWN_CATEGORY_ID;
    }

    public getMaterialId(mat: string): number {
        return this.matIdMap.get(mat) ?? ENGINE_DEFAULTS.UNKNOWN_MATERIAL_ID;
    }

    public getEnchantId(name: string): number {
        return this.idMap.get(name) ?? ENGINE_DEFAULTS.UNKNOWN_ENCHANT_ID;
    }

    public hasConflict(idA: number, idB: number): boolean {
        return (this.conflictBitsets[idA] & (1n << BigInt(idB))) !== 0n;
    }

    public isCategoryAvailable(cat: string): boolean {
        const pool = this.mergedItems[cat];
        return !!(pool && pool.length > 0);
    }

    public getCategoryPool(cat: string): string[] {
        return this.mergedItems[cat] || [];
    }

    public getFullEnchantName(idAndRank: number): string {
        const id = idAndRank >> 8;
        const rank = idAndRank & 0xFF;
        return `${this.getEnchantName(id)} ${this.getRankRoman(rank)}`;
    }

    /**
     * Gets a list of enchants eligible for a specific modified level, filtered by material logic.
     * Returns array of PackedEnchant (id << 8 | rank).
     */
    public getEligiblePool(cat: string, level: number, mat: string): PackedEnchant[] {
        const cacheKey = `${cat}|${level}|${mat}`;
        const cached = this.poolCache.get(cacheKey);
        if (cached) return cached;

        const pool = this.versionPool.get(cat) || [];
        const out: PackedEnchant[] = [];
        
        for (const name of pool) {
            const props = this.resolvedRegistry[name];
            const id = this.idMap.get(name)!;
            
            for (const [r, rankVal] of this.sortedRanks) {
                const range = props.levels[r];
                if (range && level >= range[0] && level <= range[1]) {
                    out.push((id << 8) | rankVal);
                    break;
                }
            }
        }

        this.poolCache.set(cacheKey, out);
        return out;
    }

    /**
     * Checks if a specific enchantment (full name with rank) can be achieved 
     * in any of the modified levels within a given range.
     */
    public isEnchantmentAchievable(fullName: string, cat: string, mat: string, levels: number[]): boolean {
        for (const ml of levels) {
            const pool = this.getEligiblePool(cat, ml, mat);
            if (pool.some(p => this.getFullEnchantName(p) === fullName)) return true;
        }
        return false;
    }

    public getEnchantability(mat: string, cat: string): number {
        if (cat === "book") return 1;
        const { armor, tools } = this.data.material_values;
        const isArmor = this.data.constants.ARMOR_CATS.includes(cat);
        return (isArmor ? armor[mat] : tools[mat]) || 10;
    }
}
