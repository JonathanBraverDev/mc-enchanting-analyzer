import {
    ConflictRule,
    ConflictRuleSelector,
    EnchantableItemRule,
    EnchantableItemRuleSelector,
    Enchantment,
    EnchantmentData,
    EnchantmentGroupRule,
    EnchantmentGroupRuleSelector,
    MutatedRegistryState,
    MaterialRule,
    MaterialRuleSelector,
    RegistryMutation,
    RegistryState,
    VanillaRegistryState,
    VersionManifest
} from '#types/index.js';
import { isAvailabilityActive } from '#core/availability.js';
import { resolveManifestVersion, resolveRegistryVersion } from '#core/version-resolution.js';
import { DATA } from '#data/index.js';
import { VersionUtils } from '#utils/index.js';


/**
 * Factory for building a fully initialized Registry state.
 */
export class RegistryFactory {
    public static build(version: string): VanillaRegistryState {
        return {
            ...this.createState(DATA, version),
            source: 'vanilla'
        };
    }

    public static buildWithMutations(
        version: string,
        mutations: RegistryMutation | RegistryMutation[]
    ): MutatedRegistryState {
        const data = this.cloneData(DATA);
        const list = Array.isArray(mutations) ? mutations : [mutations];
        const appliedMutations = list.map(mutation => this.cloneRule(mutation));

        for (const mutation of appliedMutations) {
            this.applyRegistryMutation(data, mutation);
        }

        this.validateMutatedData(data);

        return {
            ...this.createState(data, version),
            source: 'mutated',
            mutations: Object.freeze(appliedMutations)
        };
    }

    private static cloneData(data: EnchantmentData): EnchantmentData {
        return JSON.parse(JSON.stringify(data)) as EnchantmentData;
    }

    private static applyRegistryMutation(data: EnchantmentData, mutation: RegistryMutation): void {
        switch (mutation.type) {
            case 'patchEnchantment':
                this.patchEnchantment(data, mutation.enchantment, mutation.patch);
                break;
            case 'addConflictRule':
                data.conflict_rules.push(this.cloneRule(mutation.rule));
                break;
            case 'removeConflictRule':
                this.removeExactly(
                    data.conflict_rules,
                    mutation.selector,
                    this.matchesConflictRule,
                    mutation.type
                );
                break;
            case 'addEnchantmentGroupRule':
                data.enchantment_group_rules.push(this.cloneRule(mutation.rule));
                break;
            case 'removeEnchantmentGroupRule':
                this.removeExactly(
                    data.enchantment_group_rules,
                    mutation.selector,
                    this.matchesEnchantmentGroupRule,
                    mutation.type
                );
                break;
            case 'addMaterialRule':
                data.material_rules.push(this.cloneRule(mutation.rule));
                break;
            case 'removeMaterialRule':
                this.removeExactly(
                    data.material_rules,
                    mutation.selector,
                    this.matchesMaterialRule,
                    mutation.type
                );
                break;
            case 'addEnchantableItemRule':
                data.enchantable_item_rules.push(this.cloneRule(mutation.rule));
                break;
            case 'removeEnchantableItemRule':
                this.removeExactly(
                    data.enchantable_item_rules,
                    mutation.selector,
                    this.matchesEnchantableItemRule,
                    mutation.type
                );
                break;
        }
    }

    private static patchEnchantment(
        data: EnchantmentData,
        enchantment: string,
        patch: Partial<Enchantment>
    ): void {
        if (!Object.hasOwn(data.global_enchantments, enchantment)) {
            throw new Error(`patchEnchantment cannot patch unknown enchantment "${enchantment}".`);
        }

        const existing = data.global_enchantments[enchantment]!;
        const { levels } = patch;
        if (Object.hasOwn(patch, 'weight')) existing.weight = patch.weight!;
        if (Object.hasOwn(patch, 'valid_from')) {
            if (patch.valid_from === undefined) delete existing.valid_from;
            else existing.valid_from = patch.valid_from;
        }
        if (Object.hasOwn(patch, 'valid_until')) {
            if (patch.valid_until === undefined) delete existing.valid_until;
            else existing.valid_until = patch.valid_until;
        }
        if (levels) {
            existing.levels = {
                ...existing.levels,
                ...levels
            };
        }
    }

    private static cloneRule<T>(rule: T): T {
        return JSON.parse(JSON.stringify(rule)) as T;
    }

    private static validateMutatedData(data: EnchantmentData): void {
        const enchantNames = new Set(Object.keys(data.global_enchantments));
        const groupNames = new Set(data.enchantment_group_rules.map(rule => rule.group));
        const materialNames = new Set(Object.values(data.material_values).flatMap(table => Object.keys(table)));
        const materialRefs = new Set([...materialNames, ...Object.keys(data.material_sets)]);
        const enchantabilityTables = new Set(['tool', 'armor', 'other']);
        const romanMap = data.constants.ROMAN_MAP;

        for (const [name, enchantment] of Object.entries(data.global_enchantments)) {
            this.assertAvailabilityOrder(enchantment, `enchantment "${name}"`);
            if (typeof enchantment.weight !== 'number' || enchantment.weight < 1) {
                throw new Error(`Invalid enchantment "${name}": weight must be >= 1.`);
            }
            const levelEntries = Object.entries(enchantment.levels ?? {});
            if (levelEntries.length === 0) {
                throw new Error(`Invalid enchantment "${name}": levels must not be empty.`);
            }
            const rankValues: number[] = [];
            for (const [rank, range] of levelEntries) {
                const rankValue = romanMap[rank];
                if (typeof rankValue !== 'number') {
                    throw new Error(`Invalid enchantment "${name}" level "${rank}": unknown rank name.`);
                }
                rankValues.push(rankValue);
                if (!Array.isArray(range) || range.length !== 2 || range[0] < 1 || range[0] >= range[1]) {
                    throw new Error(`Invalid enchantment "${name}" level "${rank}": expected [min, max] with 1 <= min < max.`);
                }
            }
            rankValues.sort((a, b) => a - b);
            for (let i = 0; i < rankValues.length; i++) {
                if (rankValues[i] !== i + 1) {
                    throw new Error(`Invalid enchantment "${name}": level ranks must be contiguous from I.`);
                }
            }
        }

        for (const rule of data.conflict_rules) {
            this.assertAvailabilityOrder(rule, `conflict rule "${rule.enchants.join(' <-> ')}"`);
            const [left, right] = rule.enchants;
            if (left === right || !enchantNames.has(left) || !enchantNames.has(right)) {
                throw new Error(`Invalid conflict rule "${left} <-> ${right}": enchantments must be known and distinct.`);
            }
        }

        for (const rule of data.enchantment_group_rules) {
            this.assertAvailabilityOrder(rule, `enchantment group rule "${rule.group}"`);
            if (rule.enchantments.length === 0) {
                throw new Error(`Invalid enchantment group rule "${rule.group}": enchantments must not be empty.`);
            }
            for (const enchantment of rule.enchantments) {
                if (!enchantNames.has(enchantment)) {
                    throw new Error(`Invalid enchantment group rule "${rule.group}": unknown enchantment "${enchantment}".`);
                }
            }
        }

        for (const rule of data.material_rules) {
            this.assertAvailabilityOrder(rule, `material rule "${rule.material}"`);
            if (!materialNames.has(rule.material)) {
                throw new Error(`Invalid material rule "${rule.material}": unknown material.`);
            }
        }

        for (const rule of data.enchantable_item_rules) {
            this.assertAvailabilityOrder(rule, `enchantable item rule "${rule.item}"`);
            if (!enchantabilityTables.has(rule.enchantability)) {
                throw new Error(`Invalid enchantable item rule "${rule.item}": unknown enchantability table "${rule.enchantability}".`);
            }
            if (rule.groups === undefined) {
                if (rule.item !== 'book') {
                    throw new Error(`Invalid enchantable item rule "${rule.item}": only book may omit groups.`);
                }
            } else if (rule.groups.length === 0) {
                throw new Error(`Invalid enchantable item rule "${rule.item}": groups must not be empty.`);
            } else {
                for (const entry of rule.groups) {
                    if (!groupNames.has(entry) && !enchantNames.has(entry)) {
                        throw new Error(`Invalid enchantable item rule "${rule.item}": unknown group or enchantment "${entry}".`);
                    }
                }
            }

            if (rule.materials.length === 0) {
                throw new Error(`Invalid enchantable item rule "${rule.item}": materials must not be empty.`);
            }
            for (const material of rule.materials) {
                if (!materialRefs.has(material)) {
                    throw new Error(`Invalid enchantable item rule "${rule.item}": unknown material or material set "${material}".`);
                }
            }
        }
    }

    private static assertAvailabilityOrder(
        entry: { valid_from?: string; valid_until?: string },
        context: string
    ): void {
        if (entry.valid_from && entry.valid_until && VersionUtils.compare(entry.valid_until, entry.valid_from) <= 0) {
            throw new Error(`Invalid ${context}: valid_until must be after valid_from.`);
        }
    }

    private static removeExactly<T, S>(
        rules: T[],
        selector: S,
        matches: (rule: T, selector: S) => boolean,
        operation: string
    ): void {
        const indexes: number[] = [];
        for (const [index, rule] of rules.entries()) {
            if (matches(rule, selector)) indexes.push(index);
        }

        if (indexes.length !== 1) {
            throw new Error(`${operation} expected exactly one matching rule; found ${indexes.length}.`);
        }

        rules.splice(indexes[0]!, 1);
    }

    private static matchesConflictRule(rule: ConflictRule, selector: ConflictRuleSelector): boolean {
        const [leftRule, rightRule] = RegistryFactory.normalizeEnchantPair(rule.enchants);
        const [leftSelector, rightSelector] = RegistryFactory.normalizeEnchantPair(selector.enchants);
        return leftRule === leftSelector
            && rightRule === rightSelector
            && RegistryFactory.matchesRuleBoundary(rule, selector);
    }

    private static matchesEnchantmentGroupRule(
        rule: EnchantmentGroupRule,
        selector: EnchantmentGroupRuleSelector
    ): boolean {
        return rule.group === selector.group && RegistryFactory.matchesRuleBoundary(rule, selector);
    }

    private static matchesMaterialRule(rule: MaterialRule, selector: MaterialRuleSelector): boolean {
        return rule.material === selector.material && RegistryFactory.matchesRuleBoundary(rule, selector);
    }

    private static matchesEnchantableItemRule(
        rule: EnchantableItemRule,
        selector: EnchantableItemRuleSelector
    ): boolean {
        return rule.item === selector.item && RegistryFactory.matchesRuleBoundary(rule, selector);
    }

    private static matchesRuleBoundary(
        rule: { valid_from: string; valid_until?: string },
        selector: { valid_from: string; valid_until?: string }
    ): boolean {
        return rule.valid_from === selector.valid_from
            && rule.valid_until === selector.valid_until;
    }

    private static normalizeEnchantPair(pair: [string, string]): [string, string] {
        return pair[0].localeCompare(pair[1]) <= 0 ? pair : [pair[1], pair[0]];
    }

    private static createState(data: EnchantmentData, version: string): RegistryState {
        if (version == null || typeof version !== 'string') {
            throw new Error(`Invalid version: expected a string, got ${version == null ? 'null/undefined' : typeof version}.`);
        }
        if (version === '') {
            throw new Error('Invalid version: empty string is not allowed.');
        }
        const itemPool = {};
        const itemMaterials = {};
        const itemEnchantability = {};
        const itemIdMap = new Map<string, number>();
        const materialIdMap = new Map<string, number>();
        const state: RegistryState = {
            version: "",
            mechanics: {},
            romanMap: data.constants.ROMAN_MAP,
            materialPriority: data.constants.MATERIAL_PRIORITY,
            materialValues: data.material_values,
            itemPool,
            mergedOverrides: {},
            resolvedRegistry: {},
            mergedMaterials: new Set<string>(),
            itemMaterials,
            itemEnchantability,
            multiEnchantBooks: true,
            idMap: new Map(),
            revIdMap: [],
            itemIdMap,
            materialIdMap,
            conflictBitsets: new BigUint64Array(0),
            weightMap: new Uint32Array(0),
            sortedRanks: [],
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

        // 4. Project active item, material, and group rules for this version
        this.applyRegistryRules(state, data);

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
        this.buildConflictBitsets(state, data, allEnchNames);

        const romanMap = data.constants.ROMAN_MAP;
        // Sorted descending by rank value so getEligiblePool finds the highest achievable rank first.
        state.sortedRanks = Object.entries(romanMap).sort((a, b) => b[1] - a[1]);

        // Initialize enchantment pairs (id << 8 | rank)
        this.initializeEnchantmentPairs(state, data, allEnchNames);
    }

    private static resolveEnchantmentProps(
        state: RegistryState,
        data: EnchantmentData,
        allEnchNames: string[]
    ): void {
        for (const [i, name] of allEnchNames.entries()) {
            if (name === undefined) continue;
            const props = Object.assign({}, data.global_enchantments[name], state.mergedOverrides[name] || {}) as Enchantment;
            state.resolvedRegistry[name] = props;
            state.weightMap[i] = props.weight;
        }
    }

    private static buildConflictBitsets(state: RegistryState, data: EnchantmentData, allEnchNames: string[]): void {
        const activeNames = new Set(
            allEnchNames.filter(name => {
                const entry = state.resolvedRegistry[name];
                return entry !== undefined && isAvailabilityActive(state.version, entry);
            })
        );

        for (const rule of data.conflict_rules) {
            if (!isAvailabilityActive(state.version, rule)) continue;
            const [left, right] = rule.enchants;
            if (!activeNames.has(left) || !activeNames.has(right)) continue;

            const leftId = state.idMap.get(left);
            const rightId = state.idMap.get(right);
            if (leftId === undefined || rightId === undefined) continue;

            state.conflictBitsets[leftId] = (state.conflictBitsets[leftId] ?? 0n) | (1n << BigInt(rightId));
            state.conflictBitsets[rightId] = (state.conflictBitsets[rightId] ?? 0n) | (1n << BigInt(leftId));
        }
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
        Object.values(materialValues)
            .flatMap(table => Object.keys(table))
            .forEach(material => addId(state.materialIdMap, material));

        data.enchantable_item_rules.forEach(rule => {
            addId(state.itemIdMap, rule.item);
            this.resolveMaterialRefs(data, rule.materials).forEach(material => addId(state.materialIdMap, material));
        });
    }

    private static applyRegistryRules(state: RegistryState, data: EnchantmentData): void {
        const activeEnchantments = this.getActiveRegistryEnchantments(state);
        const activeEnchantmentSet = new Set(activeEnchantments);
        const activeGroupMembers = this.getActiveGroupMembers(state, data);
        const groupNames = new Set(data.enchantment_group_rules.map(rule => rule.group));
        const activeMaterials = new Set<string>();

        for (const rule of data.material_rules) {
            if (isAvailabilityActive(state.version, rule)) {
                activeMaterials.add(rule.material);
            }
        }
        state.mergedMaterials = activeMaterials;

        for (const rule of data.enchantable_item_rules) {
            if (!isAvailabilityActive(state.version, rule)) continue;

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
            state.itemEnchantability[rule.item] = rule.enchantability;
        }
    }

    private static getActiveGroupMembers(
        state: RegistryState,
        data: EnchantmentData
    ): Map<string, string[]> {
        const groups = new Map<string, string[]>();
        const seenByGroup = new Map<string, Set<string>>();
        for (const rule of data.enchantment_group_rules) {
            if (!isAvailabilityActive(state.version, rule)) continue;
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

    private static getActiveRegistryEnchantments(state: RegistryState): string[] {
        return Object.keys(state.resolvedRegistry).filter(name => {
            const props = state.resolvedRegistry[name];
            return props !== undefined && isAvailabilityActive(state.version, props);
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
