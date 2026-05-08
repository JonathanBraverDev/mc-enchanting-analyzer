import { EnchantmentData, VersionManifest, Enchantment, RegistryState } from '#types/index.js';
import { isAvailabilityActive, normalizeAvailability } from '#core/availability.js';
import type { RegistryAvailability } from '#core/availability.js';
import { getRegistryVersionBoundaries, resolveManifestVersion, resolveRegistryVersion } from '#core/version-resolution.js';


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
        const itemPool = {};
        const itemMaterials = {};
        const itemIdMap = new Map<string, number>();
        const materialIdMap = new Map<string, number>();
        const versionPool = new Map<string, string[]>();
        const state: RegistryState = {
            data,
            version: "",
            mechanics: {},
            itemPool,
            // V6_REMOVE: Deprecated alias for itemPool.
            mergedItems: itemPool,
            mergedOverrides: {},
            resolvedRegistry: {},
            mergedMaterials: new Set<string>(),
            itemMaterials,
            // V6_REMOVE: Deprecated alias for itemMaterials.
            categoryMaterials: itemMaterials,
            multiEnchantBooks: true,
            idMap: new Map(),
            revIdMap: [],
            itemIdMap,
            // V6_REMOVE: Deprecated alias for itemIdMap.
            catIdMap: itemIdMap,
            materialIdMap,
            // V6_REMOVE: Deprecated alias for materialIdMap.
            matIdMap: materialIdMap,
            conflictBitsets: new BigUint64Array(0),
            weightMap: new Uint32Array(0),
            sortedRanks: [],
            // V6_REMOVE: Historical active item-pool map; use itemPool.
            versionPool,
            enchantToIndex: new Map(),
            indexToEnchant: [0]
        };

        const resolvedVersion = resolveRegistryVersion(data, version);
        const registryBoundaries = getRegistryVersionBoundaries(data);
        state.version = version;

        const chain = this.getInheritanceChain(data, resolveManifestVersion(data, resolvedVersion));

        // 1. Apply inheritance chain
        for (const vName of chain) {
            const manifest = data.versions[vName] as VersionManifest;
            if (manifest) this.applyVersionManifest(state, manifest);
        }

        // 2. Finalize Registry data structure
        this.finalizeEnchantmentRegistry(state, data, registryBoundaries);

        // 3. Initialize mapping lookups
        this.initializeIdMaps(state, data);

        // 4. Project active item, material, and group rules for this version
        this.applyRegistryRules(state, data, registryBoundaries);

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

    private static finalizeEnchantmentRegistry(state: RegistryState, data: EnchantmentData, registryBoundaries: readonly string[]): void {
        const enchantmentData = data.global_enchantments;
        const allEnchNames = Object.keys(enchantmentData);

        state.revIdMap = allEnchNames;
        allEnchNames.forEach((name, i) => state.idMap.set(name, i));

        state.conflictBitsets = new BigUint64Array(allEnchNames.length);
        state.weightMap = new Uint32Array(allEnchNames.length);

        // First pass: resolve all props (applying version overrides)
        this.resolveEnchantmentProps(state, data, allEnchNames, registryBoundaries);

        // Build symmetric conflict map and bitsets for enchantments active in this version.
        this.buildConflictBitsets(state, allEnchNames, registryBoundaries);

        const romanMap = data.constants.ROMAN_MAP;
        // Sorted descending by rank value so getEligiblePool finds the highest achievable rank first.
        state.sortedRanks = Object.entries(romanMap).sort((a, b) => b[1] - a[1]);

        // Initialize enchantment pairs (id << 8 | rank)
        this.initializeEnchantmentPairs(state, data, allEnchNames);
    }

    private static resolveEnchantmentProps(
        state: RegistryState,
        data: EnchantmentData,
        allEnchNames: string[],
        registryBoundaries: readonly string[]
    ): void {
        for (const [i, name] of allEnchNames.entries()) {
            if (name === undefined) continue;
            const props = Object.assign({}, data.global_enchantments[name], state.mergedOverrides[name] || {}) as Enchantment;
            const availability = normalizeAvailability(props, registryBoundaries, `enchantment "${name}"`);
            if (availability.valid_from !== undefined) props.valid_from = availability.valid_from;
            else delete props.valid_from;
            if (availability.valid_until !== undefined) props.valid_until = availability.valid_until;
            else delete props.valid_until;
            delete props.valid_to;
            state.resolvedRegistry[name] = props;
            state.weightMap[i] = props.weight;
        }
    }

    private static buildConflictBitsets(state: RegistryState, allEnchNames: string[], registryBoundaries: readonly string[]): void {
        const activeNames = new Set(
            allEnchNames.filter(name => {
                const entry = state.resolvedRegistry[name];
                return entry !== undefined && this.isTimelineEntryActive(state.version, entry, registryBoundaries, `enchantment "${name}"`);
            })
        );

        for (const rule of state.data.conflict_rules) {
            if (!this.isTimelineEntryActive(state.version, rule, registryBoundaries, `conflict rule "${rule.enchants.join(' <-> ')}"`)) continue;
            const [left, right] = rule.enchants;
            if (!activeNames.has(left) || !activeNames.has(right)) continue;

            const leftId = state.idMap.get(left);
            const rightId = state.idMap.get(right);
            if (leftId === undefined || rightId === undefined) continue;

            state.conflictBitsets[leftId] = (state.conflictBitsets[leftId] ?? 0n) | (1n << BigInt(rightId));
            state.conflictBitsets[rightId] = (state.conflictBitsets[rightId] ?? 0n) | (1n << BigInt(leftId));
        }
    }

    private static isTimelineEntryActive(
        version: string,
        entry: RegistryAvailability,
        registryBoundaries: readonly string[],
        context: string
    ): boolean {
        return isAvailabilityActive(version, entry, registryBoundaries, context);
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

        const materialValues = data.material_values;
        [...Object.keys(materialValues.tools), ...Object.keys(materialValues.armor)].forEach(material => addId(state.materialIdMap, material));

        data.enchantable_item_rules.forEach(rule => {
            addId(state.itemIdMap, rule.item);
            this.resolveMaterialRefs(data, rule.materials).forEach(material => addId(state.materialIdMap, material));
        });
    }

    private static applyRegistryRules(state: RegistryState, data: EnchantmentData, registryBoundaries: readonly string[]): void {
        const activeEnchantments = this.getActiveRegistryEnchantments(state, registryBoundaries);
        const activeEnchantmentSet = new Set(activeEnchantments);
        const activeGroupMembers = this.getActiveGroupMembers(state, data, registryBoundaries);
        const groupNames = new Set(data.enchantment_group_rules.map(rule => rule.group));
        const activeMaterials = new Set<string>();

        for (const rule of data.material_rules) {
            if (this.isTimelineEntryActive(state.version, rule, registryBoundaries, `material rule "${rule.material}"`)) {
                activeMaterials.add(rule.material);
            }
        }
        state.mergedMaterials = activeMaterials;

        for (const rule of data.enchantable_item_rules) {
            if (!this.isTimelineEntryActive(state.version, rule, registryBoundaries, `enchantable item rule "${rule.item}"`)) continue;

            if (rule.groups === undefined) {
                state.itemPool[rule.item] = activeEnchantments;
            } else {
                state.itemPool[rule.item] = this.resolveItemPoolEntries(
                    data,
                    rule.item,
                    rule.groups,
                    activeGroupMembers,
                    groupNames,
                    activeEnchantmentSet
                );
            }

            const materials = this.resolveMaterialRefs(data, rule.materials)
                .filter(material => activeMaterials.has(material));
            state.itemMaterials[rule.item] = materials;
            state.versionPool.set(rule.item, state.itemPool[rule.item] ?? []);
        }
    }

    private static getActiveGroupMembers(
        state: RegistryState,
        data: EnchantmentData,
        registryBoundaries: readonly string[]
    ): Map<string, string[]> {
        const groups = new Map<string, string[]>();
        const seenByGroup = new Map<string, Set<string>>();
        for (const rule of data.enchantment_group_rules) {
            if (!this.isTimelineEntryActive(state.version, rule, registryBoundaries, `enchantment group rule "${rule.group}"`)) continue;
            let members = groups.get(rule.group);
            if (!members) {
                members = [];
                groups.set(rule.group, members);
            }
            let seen = seenByGroup.get(rule.group);
            if (!seen) {
                seen = new Set<string>();
                seenByGroup.set(rule.group, seen);
            }
            for (const enchantment of rule.enchantments) {
                if (seen.has(enchantment)) continue;
                seen.add(enchantment);
                members.push(enchantment);
            }
        }

        return groups;
    }

    private static resolveItemPoolEntries(
        data: EnchantmentData,
        item: string,
        entries: string[],
        activeGroupMembers: Map<string, string[]>,
        groupNames: Set<string>,
        activeEnchantments: Set<string>
    ): string[] {
        const resolved: string[] = [];
        const seen = new Set<string>();

        for (const entry of entries) {
            const groupMembers = activeGroupMembers.get(entry);
            if (groupMembers) {
                this.addActivePoolEntries(resolved, seen, groupMembers, activeEnchantments);
                continue;
            }

            if (groupNames.has(entry)) continue;

            if (Object.hasOwn(data.global_enchantments, entry)) {
                this.addActivePoolEntries(resolved, seen, [entry], activeEnchantments);
                continue;
            }

            throw new Error(`Unknown enchantment group or enchantment "${entry}" in item rule "${item}".`);
        }

        return resolved;
    }

    private static addActivePoolEntries(
        resolved: string[],
        seen: Set<string>,
        entries: string[],
        activeEnchantments: Set<string>
    ): void {
        for (const enchantment of entries) {
            if (!activeEnchantments.has(enchantment) || seen.has(enchantment)) continue;
            seen.add(enchantment);
            resolved.push(enchantment);
        }
    }

    private static getActiveRegistryEnchantments(state: RegistryState, registryBoundaries: readonly string[]): string[] {
        return Object.keys(state.resolvedRegistry).filter(name => {
            const props = state.resolvedRegistry[name];
            return props !== undefined && this.isTimelineEntryActive(state.version, props, registryBoundaries, `enchantment "${name}"`);
        });
    }

    private static resolveMaterialRefs(data: EnchantmentData, refs: string[]): string[] {
        const resolved: string[] = [];
        const seen = new Set<string>();

        for (const ref of refs) {
            const materials = data.material_sets[ref] ?? [ref];
            for (const material of materials) {
                if (seen.has(material)) continue;
                seen.add(material);
                resolved.push(material);
            }
        }

        return resolved;
    }
}
