import { PACKING_CONSTANTS } from '#constants/engine.js';
import { getEnchantId, getEnchantName, getFullEnchantName, getRankRoman } from '#core/registry.js';
import type {
    PackedCombo,
    PackedTargetRequirement,
    RegistryState,
    SearchFrontierSnapshot,
    TargetAnalysisResult,
    TargetRequirementInput
} from '#types/index.js';
import { ComboUtils, ProbUtils } from '#utils/index.js';

export interface TargetAnalysisRequest {
    combos: Map<PackedCombo, bigint>;
    indexToEnchant: number[];
    targets?: PackedTargetRequirement[] | undefined;
    frontiers?: SearchFrontierSnapshot[] | undefined;
    comboLimit?: number | undefined;
    registry?: RegistryState | undefined;
    isBook?: boolean | undefined;
}

export class TargetAnalysisService {
    public static packTargets(
        registry: RegistryState,
        item: string,
        targets: TargetRequirementInput[] | undefined
    ): PackedTargetRequirement[] {
        if (!targets || targets.length === 0) return [];

        const pool = registry.itemPool[item];
        if (pool === undefined) throw new Error(`Unknown item "${item}"`);

        const byEnchant = new Map<number, PackedTargetRequirement>();
        for (const target of targets) {
            const rankMode = target.rankMode;
            if (rankMode !== 'atLeast') {
                throw new Error(`Unsupported target rank mode: ${rankMode}`);
            }

            if (!pool.includes(target.enchantment)) {
                throw new Error(`Target enchantment "${target.enchantment}" is not applicable to item "${item}"`);
            }

            const enchant = registry.resolvedRegistry[target.enchantment];
            if (!enchant) {
                throw new Error(`Unknown target enchantment: "${target.enchantment}"`);
            }

            const enchantmentId = getEnchantId(registry, target.enchantment);
            const maxRank = Object.keys(enchant.levels).length;
            if (target.rank < 1 || target.rank > maxRank) {
                throw new Error(`Target rank ${target.rank} for "${target.enchantment}" exceeds max rank ${maxRank}`);
            }

            const idAndRank = (enchantmentId << PACKING_CONSTANTS.ENCHANT_SHIFT) | target.rank;
            const packed = {
                idAndRank,
                enchantmentId,
                rank: target.rank,
                rankMode,
                label: `${getFullEnchantName(registry, idAndRank)}+`
            };

            const existing = byEnchant.get(enchantmentId);
            if (!existing || target.rank > existing.rank) {
                byEnchant.set(enchantmentId, packed);
            }
        }

        const packedTargets = [...byEnchant.values()].sort((a, b) => a.label.localeCompare(b.label));
        this.validateTargetCompatibility(registry, packedTargets);
        return packedTargets;
    }

    public static makeTargetInput(registry: RegistryState, idAndRank: number): TargetRequirementInput {
        return {
            enchantment: getEnchantName(registry, idAndRank >> PACKING_CONSTANTS.ENCHANT_SHIFT),
            rank: idAndRank & PACKING_CONSTANTS.RANK_MASK,
            rankMode: 'atLeast'
        };
    }

    public static matchesCombo(
        packed: PackedCombo,
        targets: PackedTargetRequirement[],
        indexToEnchant: number[]
    ): boolean {
        if (targets.length === 0) return false;

        let matched = 0;
        ComboUtils.forEachEnchant(packed, indexToEnchant, (enchant) => {
            const enchantId = ComboUtils.getEnchantId(enchant);
            const rank = ComboUtils.getEnchantRank(enchant);

            for (const target of targets) {
                if (target.enchantmentId === enchantId && rank >= target.rank) {
                    matched++;
                    break;
                }
            }
        });

        return matched >= targets.length;
    }

    public static aggregate(request: TargetAnalysisRequest): TargetAnalysisResult | undefined {
        const {
            combos,
            indexToEnchant,
            targets = [],
            frontiers = [],
            comboLimit = 50,
            registry,
            isBook = false
        } = request;

        if (targets.length === 0) return undefined;

        let matchMass = 0n;
        let pendingNearMissMass = 0n;
        let pendingBlockedMass = 0n;
        const matchingCombos = new Map<PackedCombo, bigint>();
        const nearMissCombos = new Map<PackedCombo, bigint>();
        const blockedCombos = new Map<PackedCombo, bigint>();

        for (const [packed, mass] of combos) {
            const classification = this.classifyCombo(packed, targets, indexToEnchant, registry);
            if (classification.matches) {
                matchMass += mass;
                this.addComboMass(matchingCombos, packed, mass);
            } else {
                if (classification.nearMiss) this.addComboMass(nearMissCombos, packed, mass);
                if (classification.blockedByConflict) this.addComboMass(blockedCombos, packed, mass);
            }
        }

        for (const { frontier, graph, scale } of frontiers) {
            frontier.forEachNode((nodeId, prob) => {
                const packed = graph.getCombo(nodeId);
                const classification = this.classifyCombo(packed, targets, indexToEnchant, registry);
                const mass = ProbUtils.scale(prob, scale);
                if (classification.matches) {
                    matchMass += mass;
                    if (!isBook) this.addComboMass(matchingCombos, packed, mass);
                } else {
                    if (classification.nearMiss) {
                        if (isBook) pendingNearMissMass += mass;
                        else this.addComboMass(nearMissCombos, packed, mass);
                    }
                    if (classification.blockedByConflict) {
                        if (isBook) pendingBlockedMass += mass;
                        else this.addComboMass(blockedCombos, packed, mass);
                    }
                }
            });
        }

        const topCombos: [PackedCombo, bigint][] = [];
        for (const entry of matchingCombos.entries()) {
            this.insertTopCombo(topCombos, entry, comboLimit);
        }

        return {
            matchMass,
            matchingComboCount: matchingCombos.size,
            nearMissMass: this.sumComboMass(nearMissCombos) + pendingNearMissMass,
            nearMissComboCount: nearMissCombos.size,
            blockedMass: this.sumComboMass(blockedCombos) + pendingBlockedMass,
            blockedComboCount: blockedCombos.size,
            combos: new Map(topCombos)
        };
    }

    public static getTargetOptions(registry: RegistryState, item: string): TargetRequirementInput[] {
        const pool = registry.itemPool[item] ?? [];
        const options: TargetRequirementInput[] = [];

        for (const enchantment of pool) {
            const props = registry.resolvedRegistry[enchantment];
            if (!props) continue;
            for (let rank = 1; rank <= Object.keys(props.levels).length; rank++) {
                options.push({ enchantment, rank, rankMode: 'atLeast' });
            }
        }

        return options.sort((a, b) => {
            const nameCompare = a.enchantment.localeCompare(b.enchantment);
            return nameCompare !== 0 ? nameCompare : b.rank - a.rank;
        });
    }

    public static getTargetOptionLabel(registry: RegistryState, target: TargetRequirementInput): string {
        return `${target.enchantment} ${getRankRoman(registry, target.rank)}+`;
    }

    public static targetsConflict(
        registry: RegistryState,
        a: Pick<PackedTargetRequirement, 'enchantmentId'>,
        b: Pick<PackedTargetRequirement, 'enchantmentId'>
    ): boolean {
        if (a.enchantmentId === b.enchantmentId) return false;
        const conflicts = registry.conflictBitsets[a.enchantmentId] ?? 0n;
        return (conflicts & (1n << BigInt(b.enchantmentId))) !== 0n;
    }

    private static insertTopCombo(
        target: [PackedCombo, bigint][],
        entry: [PackedCombo, bigint],
        comboLimit: number
    ): void {
        if (comboLimit <= 0) return;

        let low = 0, high = target.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (this.compareComboEntry(entry, target[mid]!) < 0) high = mid;
            else low = mid + 1;
        }

        target.splice(low, 0, entry);
        if (target.length > comboLimit) target.pop();
    }

    private static compareComboEntry(a: [PackedCombo, bigint], b: [PackedCombo, bigint]): number {
        if (a[1] !== b[1]) return a[1] > b[1] ? -1 : 1;
        return a[0] > b[0] ? -1 : (a[0] < b[0] ? 1 : 0);
    }

    private static validateTargetCompatibility(
        registry: RegistryState,
        targets: PackedTargetRequirement[]
    ): void {
        for (let i = 0; i < targets.length; i++) {
            const left = targets[i]!;
            for (let j = i + 1; j < targets.length; j++) {
                const right = targets[j]!;
                if (this.targetsConflict(registry, left, right)) {
                    throw new Error(`Target enchantments "${left.label}" and "${right.label}" conflict and cannot appear together`);
                }
            }
        }
    }

    private static classifyCombo(
        packed: PackedCombo,
        targets: PackedTargetRequirement[],
        indexToEnchant: number[],
        registry?: RegistryState | undefined
    ): { matches: boolean; nearMiss: boolean; blockedByConflict: boolean } {
        const matchedTargets = new Array<boolean>(targets.length).fill(false);
        const comboEnchantIds: number[] = [];

        ComboUtils.forEachEnchant(packed, indexToEnchant, (enchant) => {
            const enchantId = ComboUtils.getEnchantId(enchant);
            const rank = ComboUtils.getEnchantRank(enchant);
            comboEnchantIds.push(enchantId);

            for (let i = 0; i < targets.length; i++) {
                const target = targets[i]!;
                if (target.enchantmentId === enchantId && rank >= target.rank) {
                    matchedTargets[i] = true;
                }
            }
        });

        const matchedCount = matchedTargets.filter(Boolean).length;
        const missingCount = targets.length - matchedCount;
        const matches = missingCount === 0;
        const nearMiss = targets.length > 1 && missingCount === 1;
        const blockedByConflict = nearMiss && registry !== undefined
            ? this.isMissingTargetBlockedByConflict(targets, matchedTargets, comboEnchantIds, registry)
            : false;

        return { matches, nearMiss, blockedByConflict };
    }

    private static isMissingTargetBlockedByConflict(
        targets: PackedTargetRequirement[],
        matchedTargets: boolean[],
        comboEnchantIds: number[],
        registry: RegistryState
    ): boolean {
        const missingIndex = matchedTargets.findIndex(matched => !matched);
        if (missingIndex < 0) return false;

        const missingTarget = targets[missingIndex]!;
        const conflictBitset = registry.conflictBitsets[missingTarget.enchantmentId] ?? 0n;
        for (const enchantId of comboEnchantIds) {
            if ((conflictBitset & (1n << BigInt(enchantId))) !== 0n) return true;
        }

        return false;
    }

    private static addComboMass(combos: Map<PackedCombo, bigint>, packed: PackedCombo, mass: bigint): void {
        combos.set(packed, (combos.get(packed) ?? 0n) + mass);
    }

    private static sumComboMass(combos: Map<PackedCombo, bigint>): bigint {
        let total = 0n;
        for (const mass of combos.values()) total += mass;
        return total;
    }
}
