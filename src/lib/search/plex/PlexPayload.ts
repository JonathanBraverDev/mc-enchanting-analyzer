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

export interface PlexPayload {
    readonly combo: PlexCombo;
    /** Weighted choices aligned with `combo.choices`; ratios are reduced per choice. */
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

export function materializePlexPayloadFactors(
    payload: PlexPayload,
    enchantToIndex: Map<number, number>
): readonly PlexComboFactor[] {
    if (payload.combo.choices.length !== payload.choices.length) {
        throw new Error('Plex payload combo choices and weighted choices must have the same length.');
    }

    const materialized: PlexComboFactor[] = [];
    const selected = [...payload.combo.fixed];

    function visit(choiceIndex: number, numerator: bigint, denominator: bigint): void {
        if (choiceIndex >= payload.choices.length) {
            materialized.push(Object.freeze({
                combo: ComboUtils.pack(selected, enchantToIndex),
                numerator,
                denominator
            }));
            return;
        }

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

        for (const alternative of choice.alternatives) {
            selected.push(alternative.packedEnchant);
            visit(
                choiceIndex + 1,
                numerator * BigInt(alternative.ratio),
                denominator * BigInt(choice.totalRatio)
            );
            selected.pop();
        }
    }

    visit(0, 1n, 1n);
    return Object.freeze(materialized);
}

function canonicalizeWeightedChoices(
    choices: readonly PlexWeightedChoice[]
): readonly PlexWeightedChoice[] {
    return Object.freeze([...choices].sort(comparePlexWeightedChoices));
}
