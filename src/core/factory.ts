import { EnchantmentData, VersionManifest, Enchantment, ResolvedRegistry, MergedItems, MergedOverrides, RegistryState } from '../types/index.js';
import { VersionUtils } from '../utils/index.js';


/**
 * Factory for building a fully initialized Registry state.
 */
export class RegistryFactory {
    public static build(data: EnchantmentData, version: string): RegistryState {
        if (version == null || typeof version !== 'string') {
            throw new Error(`Invalid version: expected a string, got ${version == null ? 'null/undefined' : typeof version}.`);
        }
        if (version === '') {
            throw new Error('Invalid version: empty string is not allowed.');
        }
        const state: RegistryState = {
            data,
            version: "",
            mechanics: {},
            mergedItems: {},
            mergedOverrides: {},
            resolvedRegistry: {},
            mergedMaterials: new Set<string>(),
            multiEnchantBooks: true,
            idMap: new Map(),
            revIdMap: [],
            catIdMap: new Map(),
            matIdMap: new Map(),
            conflictBitsets: new BigUint64Array(0),
            weightMap: new Uint32Array(0),
            sortedRanks: [],
            versionPool: new Map(),
            enchantToIndex: new Map(),
            indexToEnchant: [0]
        };

        const resolvedVersion = this.resolveVersion(data, version);
        state.version = version;
        
        const chain = this.getInheritanceChain(data, resolvedVersion);

        // 1. Apply inheritance chain
        for (const vName of chain) {
            const manifest = data.versions[vName] as VersionManifest;
            if (manifest) this.applyVersionManifest(state, data, manifest);
        }

        // 2. Finalize Registry data structure
        this.finalizeEnchantmentRegistry(state, data);
        
        // 3. Initialize mapping lookups
        this.initializeIdMaps(state, data);
        
        // 4. Filter based on version ranges
        this.filterMergedPools(state);
        
        // 5. Initialize active version pool
        this.initializeVersionPool(state);

        return state;
    }

    private static resolveVersion(data: EnchantmentData, v: string): string {
        if (data.versions[v]) return v;
        const sorted = Object.keys(data.versions).sort(VersionUtils.compare);
        let resolved = sorted[0];
        for (const ver of sorted) {
            if (VersionUtils.compare(v, ver) >= 0) resolved = ver;
        }
        return resolved;
    }

    private static getInheritanceChain(data: EnchantmentData, v: string): string[] {
        const chain: string[] = [];
        let temp: string | undefined = v;
        while (temp) {
            chain.unshift(temp);
            temp = data.versions[temp]?.extends;
        }
        return chain;
    }

    private static applyVersionManifest(state: RegistryState, data: EnchantmentData, manifest: VersionManifest): void {
        if (manifest.item_enchantments) {
            for (const [cat, content] of Object.entries(manifest.item_enchantments)) {
                const resolved = content.flatMap(item => {
                    if (item === "book_pool") {
                        return Object.entries(data.global_enchantments)
                            .filter(([, e]) => (e as Enchantment).bookable !== false)
                            .map(([name]) => name);
                    }
                    return data.enchantment_groups[item] || [item];
                });
                state.mergedItems[cat] = [...new Set(resolved)];
            }
        }

        Object.assign(state.mechanics, manifest.mechanics || {});
        if (manifest.multi_enchant_books !== undefined) {
            state.multiEnchantBooks = manifest.multi_enchant_books;
        }
        
        if (manifest.overrides) {
            for (const [ench, props] of Object.entries(manifest.overrides)) {
                state.mergedOverrides[ench] = Object.assign(state.mergedOverrides[ench] || {}, props);
            }
        }

        if (manifest.materials) {
            manifest.materials.forEach(m => state.mergedMaterials.add(m));
        }
    }

    private static finalizeEnchantmentRegistry(state: RegistryState, data: EnchantmentData): void {
        const enchantmentData = data.global_enchantments;
        const allEnchNames = Object.keys(enchantmentData);

        state.revIdMap = allEnchNames;
        allEnchNames.forEach((name, i) => state.idMap.set(name, i));

        state.conflictBitsets = new BigUint64Array(allEnchNames.length);
        state.weightMap = new Uint32Array(allEnchNames.length);

        // First pass: resolve all props (applying version overrides)
        this.resolveEnchantmentProps(state, data, allEnchNames);

        // Build symmetric conflict map and bitsets
        this.buildConflictBitsets(state, allEnchNames);

        const romanMap = data.constants.ROMAN_MAP;
        state.sortedRanks = Object.entries(romanMap).sort((a, b) => b[1] - a[1]);

        // Initialize enchantment pairs (id << 8 | rank)
        this.initializeEnchantmentPairs(state, data, allEnchNames);
    }

    private static resolveEnchantmentProps(state: RegistryState, data: EnchantmentData, allEnchNames: string[]): void {
        for (let i = 0; i < allEnchNames.length; i++) {
            const name = allEnchNames[i];
            const props = Object.assign({}, data.global_enchantments[name], state.mergedOverrides[name] || {}) as Enchantment;
            state.resolvedRegistry[name] = props;
            state.weightMap[i] = props.weight;
        }
    }

    private static buildConflictBitsets(state: RegistryState, allEnchNames: string[]): void {
        const effectiveConflicts = new Map<string, Set<string>>();
        for (const name of allEnchNames) {
            effectiveConflicts.set(name, new Set(state.resolvedRegistry[name].conflicts ?? []));
        }
        for (const [name, conflicts] of effectiveConflicts) {
            for (const conflictName of conflicts) {
                effectiveConflicts.get(conflictName)?.add(name);
            }
        }

        for (let i = 0; i < allEnchNames.length; i++) {
            const name = allEnchNames[i];
            let bitset = 0n;
            for (const cName of effectiveConflicts.get(name) ?? []) {
                const cId = state.idMap.get(cName);
                if (cId !== undefined) bitset |= (1n << BigInt(cId));
            }
            state.conflictBitsets[i] = bitset;
        }
    }

    private static initializeEnchantmentPairs(state: RegistryState, data: EnchantmentData, allEnchNames: string[]): void {
        const allPairs: number[] = [];
        for (let id = 0; id < allEnchNames.length; id++) {
            const ench = data.global_enchantments[allEnchNames[id]];
            const rankCount = Object.keys(ench.levels).length;
            for (let rank = 1; rank <= rankCount; rank++) {
                allPairs.push((id << 8) | rank);
            }
        }
        allPairs.sort((a, b) => a - b);
        for (let i = 0; i < allPairs.length; i++) {
            state.enchantToIndex.set(allPairs[i], i + 1);
            state.indexToEnchant.push(allPairs[i]);
        }
    }

    private static initializeIdMaps(state: RegistryState, data: EnchantmentData): void {
        const addId = (map: Map<string, number>, key: string) => {
            if (!map.has(key)) map.set(key, map.size);
        };

        Object.keys(data.enchantment_groups).forEach(cat => addId(state.catIdMap, cat));
        
        const matValues = data.material_values;
        [...Object.keys(matValues.tools), ...Object.keys(matValues.armor)].forEach(mat => addId(state.matIdMap, mat));

        Object.values(data.versions).forEach(v => {
            if (v.item_enchantments) {
                Object.keys(v.item_enchantments).forEach(cat => {
                    addId(state.catIdMap, cat);
                    addId(state.matIdMap, cat);
                });
            }
        });

        data.constants.ITEM_SPECIFIC_CATS.forEach(cat => {
            addId(state.catIdMap, cat);
            addId(state.matIdMap, cat);
        });
    }

    private static filterMergedPools(state: RegistryState): void {
        for (const cat of Object.keys(state.mergedItems)) {
            state.mergedItems[cat] = state.mergedItems[cat].filter(name => {
                const props = state.resolvedRegistry[name];
                return VersionUtils.isInRange(state.version, props.valid_from, props.valid_to);
            });
        }
    }

    private static initializeVersionPool(state: RegistryState): void {
        for (const [cat, pool] of Object.entries(state.mergedItems)) {
            const filtered = pool.filter(name => {
                const props = state.resolvedRegistry[name];
                return VersionUtils.isInRange(state.version, props.valid_from, props.valid_to);
            });
            state.versionPool.set(cat, filtered);
        }
    }
}
