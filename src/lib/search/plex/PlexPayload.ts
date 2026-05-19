import type { PackedCombo, PackedEnchant } from '#types/index.js';
import { ComboUtils } from '#utils/index.js';
import {
    canonicalizePackedEnchantList,
    comparePlexWeightedChoices,
    getPlexChoicePackedEnchants,
    type PlexWeightedChoice
} from '#lib/search/plex/PlexChoice.js';
import {
    createPlexCombo,
    EMPTY_PLEX_COMBO,
    type PlexCombo
} from '#lib/search/plex/PlexCombo.js';
import type { PlexEdge } from '#lib/search/plex/PlexGraph.js';

export type PlexPayloadKey = string;

/**
 * Weighted accumulated combo expression carried by the plex frontier/results.
 *
 * `combo` is the unweighted expression used for canonical ordering and concrete
 * combo materialization. `choices` carries the matching edge-local weights needed
 * to split/materialize aggregate choices. The arrays are intentionally separate
 * but aligned: `combo.choices[i]` is the packed-enchant view of `choices[i]`.
 */
export interface PlexPayload {
    readonly combo: PlexCombo;
    readonly choices: readonly PlexWeightedChoice[];
}

export interface PlexComboFactor {
    readonly combo: PackedCombo;
    readonly numerator: bigint;
    readonly denominator: bigint;
}

export const EMPTY_PLEX_PAYLOAD: PlexPayload = Object.freeze({
    combo: EMPTY_PLEX_COMBO,
    choices: Object.freeze([])
});

export function createPlexPayload(
    fixed: readonly PackedEnchant[] = [],
    choices: readonly PlexWeightedChoice[] = []
): PlexPayload {
    const canonicalChoices = canonicalizeWeightedChoices(choices);
    return Object.freeze({
        combo: createPlexCombo(fixed, canonicalChoices.map(getPlexChoicePackedEnchants)),
        choices: canonicalChoices
    });
}

export function appendPlexPayloadEdge(
    payload: PlexPayload,
    edge: Pick<PlexEdge, 'choice'>
): PlexPayload {
    const alternatives = getPlexChoicePackedEnchants(edge.choice);

    if (alternatives.length === 1) {
        return createPlexPayload([...payload.combo.fixed, alternatives[0]!], payload.choices);
    }

    return createPlexPayload(payload.combo.fixed, [...payload.choices, edge.choice]);
}

export function getPlexPayloadKey(payload: PlexPayload): PlexPayloadKey {
    const fixed = payload.combo.fixed.map(packedEnchant => String(packedEnchant)).join(',');
    const choices = payload.choices
        .map(choice => choice.alternatives
            .map(alternative => `${String(alternative.packedEnchant)}:${alternative.weight}`)
            .join(','))
        .join('/');
    return `f=${fixed}|c=${choices}`;
}

export function materializePlexPayloadFactors(
    payload: PlexPayload,
    enchantToIndex: Map<number, number>
): readonly PlexComboFactor[] {
    assertAlignedPayload(payload);
    return materializePlexPayloadWithRemovedChoice(payload, enchantToIndex);
}

/**
 * Materializes the compatibility view for Minecraft's enchanted-book post-processing rule.
 *
 * If multiple enchantments were generated for a book, Minecraft removes one generated
 * enchantment uniformly at random. A plex choice group represents exactly one generated
 * enchantment slot, so removing that slot can happen before resolving its alternatives.
 */
export function materializePlexPayloadBookFactors(
    payload: PlexPayload,
    enchantToIndex: Map<number, number>
): readonly PlexComboFactor[] {
    assertAlignedPayload(payload);
    const slotCount = payload.combo.fixed.length + payload.choices.length;
    if (slotCount <= 1) return materializePlexPayloadWithRemovedChoice(payload, enchantToIndex);

    const materialized: PlexComboFactor[] = [];

    for (let fixedIndex = 0; fixedIndex < payload.combo.fixed.length; fixedIndex++) {
        materialized.push(...materializePlexPayloadWithRemovedChoice(
            payload,
            enchantToIndex,
            fixedIndex,
            undefined,
            BigInt(slotCount)
        ));
    }

    for (let choiceIndex = 0; choiceIndex < payload.choices.length; choiceIndex++) {
        materialized.push(...materializePlexPayloadWithRemovedChoice(
            payload,
            enchantToIndex,
            undefined,
            choiceIndex,
            BigInt(slotCount)
        ));
    }

    return Object.freeze(materialized);
}

function materializePlexPayloadWithRemovedChoice(
    payload: PlexPayload,
    enchantToIndex: Map<number, number>,
    removedFixedIndex?: number,
    removedChoiceIndex?: number,
    initialDenominator: bigint = 1n
): readonly PlexComboFactor[] {
    const materialized: PlexComboFactor[] = [];
    const selected = payload.combo.fixed.filter((_, index) => index !== removedFixedIndex);

    function visit(choiceIndex: number, numerator: bigint, denominator: bigint): void {
        if (choiceIndex >= payload.choices.length) {
            materialized.push(Object.freeze({
                combo: ComboUtils.pack(selected, enchantToIndex),
                numerator,
                denominator
            }));
            return;
        }

        if (choiceIndex === removedChoiceIndex) {
            visit(choiceIndex + 1, numerator, denominator);
            return;
        }

        const choice = payload.choices[choiceIndex]!;
        for (const alternative of choice.alternatives) {
            selected.push(alternative.packedEnchant);
            visit(
                choiceIndex + 1,
                numerator * BigInt(alternative.weight),
                denominator * BigInt(choice.totalWeight)
            );
            selected.pop();
        }
    }

    visit(0, 1n, initialDenominator);
    return Object.freeze(materialized);
}

function assertAlignedPayload(payload: PlexPayload): void {
    if (payload.combo.choices.length !== payload.choices.length) {
        throw new Error('Plex payload combo choices and weighted choices must have the same length.');
    }

    for (let choiceIndex = 0; choiceIndex < payload.choices.length; choiceIndex++) {
        const choice = payload.choices[choiceIndex]!;
        const packedEnchants = canonicalizePackedEnchantList(choice.alternatives.map(alternative => alternative.packedEnchant));
        const comboChoice = payload.combo.choices[choiceIndex]!;
        if (packedEnchants.length !== comboChoice.length) {
            throw new Error('Plex payload weighted choice is not aligned with combo choice.');
        }
        for (let i = 0; i < packedEnchants.length; i++) {
            if (packedEnchants[i] !== comboChoice[i]) {
                throw new Error('Plex payload weighted choice is not aligned with combo choice.');
            }
        }
    }
}

function canonicalizeWeightedChoices(
    choices: readonly PlexWeightedChoice[]
): readonly PlexWeightedChoice[] {
    return Object.freeze([...choices].sort(comparePlexWeightedChoices));
}
