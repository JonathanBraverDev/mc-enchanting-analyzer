import { PACKING_CONSTANTS } from '#constants/engine.js';
import type { PackedCombo, PackedEnchant, RegistryState } from '#types/index.js';

export class ClueSearchPolicy {
    public readonly targetEnchantId: number;
    public readonly targetConflictBitset: bigint;

    private constructor(
        public readonly targetClueId: number,
        public readonly isReachableInPool: boolean,
        registry: RegistryState
    ) {
        this.targetEnchantId = targetClueId >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        this.targetConflictBitset = registry.conflictBitsets[this.targetEnchantId] ?? 0n;
    }

    public static create(registry: RegistryState, initialPool: readonly number[], targetClueId: number): ClueSearchPolicy {
        return new ClueSearchPolicy(targetClueId, initialPool.includes(targetClueId), registry);
    }

    public containsTargetClue(packed: PackedCombo, indexToEnchant: readonly number[]): boolean {
        let mult = 1;
        for (let i = 0; i < PACKING_CONSTANTS.MAX_COMBO_SLOTS; i++, mult *= PACKING_CONSTANTS.BYTE_BASIS) {
            const idx = Math.floor(packed / mult) % PACKING_CONSTANTS.BYTE_BASIS;
            if (idx === 0) return false;
            if (indexToEnchant[idx] === this.targetClueId) return true;
        }
        return false;
    }

    public canSelectChild(candidate: PackedEnchant, targetAlreadySelected: boolean): boolean {
        if (targetAlreadySelected) return true;
        if (candidate === this.targetClueId) return true;

        const candidateEnchantId = candidate >> PACKING_CONSTANTS.ENCHANT_SHIFT;
        if (candidateEnchantId === this.targetEnchantId) return false;

        return (this.targetConflictBitset & (1n << BigInt(candidateEnchantId))) === 0n;
    }
}
