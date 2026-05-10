import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { TargetAnalysisService } from '#services/TargetAnalysisService.js';
import { ComboUtils, ProbUtils, PRECISION } from '#utils/index.js';
import { makeV7PendingEntry } from '#tests/infra/v7-snapshot-test-utils.js';
import type { PackedCombo, PackedEnchant, PackedTargetRequirement, RegistryState } from '#types/index.js';

let registry: RegistryState;
let indexToEnchant: number[];
let enchantToIndex: Map<number, number>;

const EFF_IV = 0x0104 as PackedEnchant;
const EFF_V = 0x0105 as PackedEnchant;
const FORT_III = 0x0203 as PackedEnchant;
const UNBR_III = 0x0303 as PackedEnchant;
const SILK_I = 0x0401 as PackedEnchant;

function target(enchant: PackedEnchant): PackedTargetRequirement {
    const enchantmentId = ComboUtils.getEnchantId(enchant);
    const rank = ComboUtils.getEnchantRank(enchant);
    return {
        idAndRank: enchant,
        enchantmentId,
        rank,
        rankMode: 'atLeast',
        label: `${enchantmentId}:${rank}+`
    };
}

function pack(enchants: PackedEnchant[]): PackedCombo {
    return ComboUtils.pack(enchants, enchantToIndex);
}

describe('TargetAnalysisService', () => {
    before(() => {
        registry = EngineFactory.createForVersion('1.21.11').registry;
        indexToEnchant = [0, EFF_IV, EFF_V, FORT_III, UNBR_III, SILK_I];
        enchantToIndex = new Map(indexToEnchant.map((enchant, index) => [enchant, index]));
    });

    it('matches exact and higher ranks for minimum-rank targets', () => {
        assert.strictEqual(TargetAnalysisService.matchesCombo(pack([EFF_IV]), [target(EFF_IV)], indexToEnchant), true);
        assert.strictEqual(TargetAnalysisService.matchesCombo(pack([EFF_V]), [target(EFF_IV)], indexToEnchant), true);
        assert.strictEqual(TargetAnalysisService.matchesCombo(pack([EFF_IV]), [target(EFF_V)], indexToEnchant), false);
    });

    it('requires every target enchant to be present', () => {
        const targets = [target(EFF_IV), target(FORT_III)];

        assert.strictEqual(TargetAnalysisService.matchesCombo(pack([EFF_V, FORT_III]), targets, indexToEnchant), true);
        assert.strictEqual(TargetAnalysisService.matchesCombo(pack([EFF_V]), targets, indexToEnchant), false);
    });

    it('allows incompatible target pairs and reports no matches', () => {
        const targets = [target(FORT_III), target(SILK_I)];
        const conflictRegistry = { conflictBitsets: new BigUint64Array(8) } as RegistryState;
        conflictRegistry.conflictBitsets[2] = 1n << 4n;
        conflictRegistry.conflictBitsets[4] = 1n << 2n;

        const result = TargetAnalysisService.aggregate({
            combos: new Map([[pack([FORT_III]), PRECISION], [pack([SILK_I]), PRECISION]]),
            indexToEnchant,
            targets,
            registry: conflictRegistry
        });

        assert.strictEqual(result?.matchMass, 0n);
        assert.strictEqual(result?.matchingComboCount, 0);
        assert.strictEqual(result?.nearMissMass, PRECISION * 2n);
        assert.strictEqual(result?.blockedMass, PRECISION * 2n);
    });

    it('uses non-book pending frontier target mass and displays partial combos', () => {
        const terminalCombo = pack([EFF_V, FORT_III]);
        const frontierCombo = pack([EFF_IV, FORT_III, UNBR_III]);
        const frontierMass = PRECISION / 4n;
        const frontierScale = PRECISION / 2n;
        const expectedFrontier = ProbUtils.scale(frontierMass, frontierScale);

        const result = TargetAnalysisService.aggregate({
            combos: new Map([[terminalCombo, PRECISION / 2n], [pack([EFF_V]), PRECISION / 8n]]),
            indexToEnchant,
            targets: [target(EFF_IV), target(FORT_III)],
            v7PendingEntries: [makeV7PendingEntry(frontierCombo, 3, expectedFrontier)],
            comboLimit: 10
        });

        assert.strictEqual(result?.matchMass, PRECISION / 2n + expectedFrontier);
        assert.strictEqual(result?.matchingComboCount, 2);
        assert.deepStrictEqual([...result!.combos.keys()], [terminalCombo, frontierCombo]);
    });

    it('uses pending book target mass without displaying pre-removal combos', () => {
        const terminalCombo = pack([EFF_V, FORT_III]);
        const frontierCombo = pack([EFF_IV, FORT_III, UNBR_III]);
        const frontierMass = PRECISION / 4n;
        const frontierScale = PRECISION / 2n;
        const expectedFrontier = ProbUtils.scale(frontierMass, frontierScale);

        const result = TargetAnalysisService.aggregate({
            combos: new Map([[terminalCombo, PRECISION / 2n], [pack([EFF_V]), PRECISION / 8n]]),
            indexToEnchant,
            targets: [target(EFF_IV), target(FORT_III)],
            v7PendingEntries: [makeV7PendingEntry(frontierCombo, 3, expectedFrontier)],
            comboLimit: 10,
            isBook: true
        });

        assert.strictEqual(result?.matchMass, PRECISION / 2n + expectedFrontier);
        assert.strictEqual(result?.matchingComboCount, 1);
        assert.deepStrictEqual([...result!.combos.keys()], [terminalCombo]);
    });

    it('classifies one-target-short and conflict-blocked near misses', () => {
        const conflictRegistry = { conflictBitsets: new BigUint64Array(8) } as RegistryState;
        conflictRegistry.conflictBitsets[2] = 1n << 4n;

        const oneShort = pack([EFF_V]);
        const blocked = pack([EFF_V, SILK_I]);
        const unrelated = pack([UNBR_III]);

        const result = TargetAnalysisService.aggregate({
            combos: new Map([
                [oneShort, PRECISION / 4n],
                [blocked, PRECISION / 8n],
                [unrelated, PRECISION / 16n]
            ]),
            indexToEnchant,
            targets: [target(EFF_IV), target(FORT_III)],
            registry: conflictRegistry
        });

        assert.strictEqual(result?.nearMissMass, PRECISION / 4n + PRECISION / 8n);
        assert.strictEqual(result?.nearMissComboCount, 2);
        assert.strictEqual(result?.blockedMass, PRECISION / 8n);
        assert.strictEqual(result?.blockedComboCount, 1);
    });

    it('does not classify every miss as a near miss for single-target filters', () => {
        const result = TargetAnalysisService.aggregate({
            combos: new Map([[pack([UNBR_III]), PRECISION]]),
            indexToEnchant,
            targets: [target(EFF_IV)]
        });

        assert.strictEqual(result?.nearMissMass, 0n);
        assert.strictEqual(result?.nearMissComboCount, 0);
    });

    it('keeps only the top matching combos by probability', () => {
        const high = pack([EFF_V, FORT_III]);
        const low = pack([EFF_IV, FORT_III, UNBR_III]);

        const result = TargetAnalysisService.aggregate({
            combos: new Map([[low, PRECISION / 8n], [high, PRECISION / 2n]]),
            indexToEnchant,
            targets: [target(EFF_IV), target(FORT_III)],
            comboLimit: 1
        });

        assert.deepStrictEqual([...result!.combos.entries()], [[high, PRECISION / 2n]]);
    });

    it('packs UI target inputs and dedupes repeated enchantments to the stricter rank', () => {
        const packed = TargetAnalysisService.packTargets(registry, 'pickaxe', [
            { enchantment: 'Efficiency', rank: 4, rankMode: 'atLeast' },
            { enchantment: 'Fortune', rank: 3, rankMode: 'atLeast' },
            { enchantment: 'Efficiency', rank: 5, rankMode: 'atLeast' }
        ]);

        assert.deepStrictEqual(packed.map(t => t.label), ['Efficiency V+', 'Fortune III+']);
    });

    it('rejects conflicting target requirements', () => {
        assert.throws(
            () => TargetAnalysisService.packTargets(registry, 'sword', [
                { enchantment: 'Sharpness', rank: 1, rankMode: 'atLeast' },
                { enchantment: 'Smite', rank: 1, rankMode: 'atLeast' }
            ]),
            /conflict and cannot appear together/
        );
    });
});
