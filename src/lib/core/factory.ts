import { EnchantmentData, VersionManifest, Enchantment, RegistryState } from '#types/index.js';
import { VersionUtils } from '#utils/index.js';
import { resolveManifestVersion, resolveRegistryVersion } from '#core/version-resolution.js';


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
            categoryMaterials: {},
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

        const resolvedVersion = resolveRegistryVersion(data, version);
        state.version = version;

        const chain = this.getInheritanceChain(data, resolveManifestVersion(data, resolvedVersion));

        // 1. Apply inheritance chain
        for (const vName of chain) {
            const manifest = data.versions[vName] as VersionManifest;
            if (manifest) this.applyVersionManifest(state, manifest);
        }

        // 2. Finalize Registry data structure
        this.finalizeEnchantmentRegistry(state, data);

        // 3. Initialize mapping lookups
        this.initializeIdMaps(state, data);

        // 4. Apply active category and material rules
        this.applyRegistryRules(state, data);

        // 5. Filter based on version ranges
        this.filterMergedPools(state);

        // 6. Initialize active version pool
        this.initializeVersionPool(state);

        return state;
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

    private static applyVersionManifest(state: RegistryState, manifest: VersionManifest): void {
        Object.assign(state.mechanics, manifest.mechanics || {});
        if (manifest.multi_enchant_books !== undefined) {
            state.multiEnchantBooks = manifest.multi_enchant_books;
        }

        if (manifest.overrides) {
            for (const [ench, props] of Object.entries(manifest.overrides)) {
                state.mergedOverrides[ench] = Object.assign(state.mergedOverrides[ench] || {}, props);
            }
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

        // Build symmetric conflict map and bitsets for enchantments active in this version.
        this.buildConflictBitsets(state, allEnchNames);

        const romanMap = data.constants.ROMAN_MAP;
        // Sorted descending by rank value so getEligiblePool finds the highest achievable rank first.
        state.sortedRanks = Object.entries(romanMap).sort((a, b) => b[1] - a[1]);

        // Initialize enchantment pairs (id << 8 | rank)
        this.initializeEnchantmentPairs(state, data, allEnchNames);
    }

    private static resolveEnchantmentProps(state: RegistryState, data: EnchantmentData, allEnchNames: string[]): void {
        for (const [i, name] of allEnchNames.entries()) {
            if (name === undefined) continue;
            const props = Object.assign({}, data.global_enchantments[name], state.mergedOverrides[name] || {}) as Enchantment;
            state.resolvedRegistry[name] = props;
            state.weightMap[i] = props.weight;
        }
    }

    private static buildConflictBitsets(state: RegistryState, allEnchNames: string[]): void {
        const activeNames = new Set(
            allEnchNames.filter(name => {
                const entry = state.resolvedRegistry[name];
                return entry !== undefined && VersionUtils.isInRange(state.version, entry.valid_from, entry.valid_to);
            })
        );

        for (const rule of state.data.conflict_rules) {
            if (!this.isTimelineEntryActive(state.version, rule.valid_from, rule.valid_until)) continue;
            const [left, right] = rule.enchants;
            if (!activeNames.has(left) || !activeNames.has(right)) continue;

            const leftId = state.idMap.get(left);
            const rightId = state.idMap.get(right);
            if (leftId === undefined || rightId === undefined) continue;

            state.conflictBitsets[leftId] = (state.conflictBitsets[leftId] ?? 0n) | (1n << BigInt(rightId));
            state.conflictBitsets[rightId] = (state.conflictBitsets[rightId] ?? 0n) | (1n << BigInt(leftId));
        }
    }

    private static isTimelineEntryActive(version: string, validFrom: string, validUntil?: string): boolean {
        if (VersionUtils.compare(version, validFrom) < 0) return false;
        return validUntil === undefined || VersionUtils.compare(version, validUntil) < 0;
    }

    private static initializeEnchantmentPairs(state: RegistryState, data: EnchantmentData, allEnchNames: string[]): void {
        const allPairs: number[] = [];
        for (const [id, enName] of allEnchNames.entries()) {
            if (enName === undefined) continue;
            const ench = data.global_enchantments[enName];
            if (!ench) continue;
            const rankCount = Object.keys(ench.levels).length;
            for (let rank = 1; rank <= rankCount; rank++) {
                allPairs.push((id << 8) | rank);
            }
        }
        allPairs.sort((a, b) => a - b);
        for (const [i, pair] of allPairs.entries()) {
            if (pair === undefined) continue;
            state.enchantToIndex.set(pair, i + 1);
            state.indexToEnchant.push(pair);
        }
    }

    private static initializeIdMaps(state: RegistryState, data: EnchantmentData): void {
        const addId = (map: Map<string, number>, key: string) => {
            if (!map.has(key)) map.set(key, map.size);
        };

        Object.keys(data.enchantment_groups).forEach(cat => addId(state.catIdMap, cat));

        const matValues = data.material_values;
        [...Object.keys(matValues.tools), ...Object.keys(matValues.armor)].forEach(mat => addId(state.matIdMap, mat));

        data.category_pool_rules.forEach(rule => {
            addId(state.catIdMap, rule.category);
        });

        data.category_material_rules.forEach(rule => {
            addId(state.catIdMap, rule.category);
            rule.materials.forEach(material => addId(state.matIdMap, material));
        });
    }

    private static applyRegistryRules(state: RegistryState, data: EnchantmentData): void {
        for (const rule of data.category_pool_rules) {
            if (!this.isTimelineEntryActive(state.version, rule.valid_from, rule.valid_until)) continue;

            if (rule.groups === undefined) {
                state.mergedItems[rule.category] = this.getActiveRegistryEnchantments(state);
                continue;
            }

            const resolved = rule.groups.flatMap(item => data.enchantment_groups[item] || [item]);
            state.mergedItems[rule.category] = [...new Set(resolved)];
        }

        for (const rule of data.material_rules) {
            if (this.isTimelineEntryActive(state.version, rule.valid_from, rule.valid_until)) {
                state.mergedMaterials.add(rule.material);
            }
        }

        for (const rule of data.category_material_rules) {
            state.categoryMaterials[rule.category] = rule.materials;
        }
    }

    private static filterMergedPools(state: RegistryState): void {
        for (const cat of Object.keys(state.mergedItems)) {
            const pool = state.mergedItems[cat];
            if (!pool) continue;
            state.mergedItems[cat] = pool.filter(name => {
                const props = state.resolvedRegistry[name];
                if (!props) return false;
                return VersionUtils.isInRange(state.version, props.valid_from, props.valid_to);
            });
        }
    }

    private static getActiveRegistryEnchantments(state: RegistryState): string[] {
        return Object.keys(state.resolvedRegistry).filter(name => {
            const props = state.resolvedRegistry[name];
            return props !== undefined && VersionUtils.isInRange(state.version, props.valid_from, props.valid_to);
        });
    }

    private static initializeVersionPool(state: RegistryState): void {
        for (const [cat, pool] of Object.entries(state.mergedItems)) {
            state.versionPool.set(cat, pool);
        }
    }
}
