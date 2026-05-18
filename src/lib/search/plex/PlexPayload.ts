import type { PackedCombo, PackedEnchant } from '#types/index.js';
import { ComboUtils } from '#utils/index.js';
import {
    comparePackedEnchantLists,
    canonicalizePackedEnchantList,
    type CanonicalPackedEnchantList
} from '#lib/search/plex/PlexChoice.js';
import {
    createPlexCombo,
    EMPTY_PLEX_COMBO,
    type PlexCombo
} from '#lib/search/plex/PlexCombo.js';
import type { PlexEdge } from '#lib/search/plex/PlexGraph.js';

export interface PlexPayload {
    readonly combo: PlexCombo;
    /** Per-choice concrete weights, aligned with `combo.choices`. */
    readonly weights: readonly (readonly number[])[];
}

export interface PlexComboFactor {
    readonly combo: PackedCombo;
    readonly numerator: bigint;
    readonly denominator: bigint;
}

interface WeightedChoice {
    readonly alternatives: CanonicalPackedEnchantList;
    readonly weights: readonly number[];
}

export const EMPTY_PLEX_PAYLOAD: PlexPayload = Object.freeze({
    combo: EMPTY_PLEX_COMBO,
    weights: Object.freeze([])
});

export function createPlexPayload(
    fixed: readonly PackedEnchant[] = [],
    choices: readonly (readonly PackedEnchant[])[] = [],
    weights: readonly (readonly number[])[] = []
): PlexPayload {
    const weightedChoices = canonicalizeWeightedChoices(choices, weights);
    return Object.freeze({
        combo: createPlexCombo(fixed, weightedChoices.map(choice => choice.alternatives)),
        weights: Object.freeze(weightedChoices.map(choice => choice.weights))
    });
}

export function appendPlexPayloadEdge(
    payload: PlexPayload,
    edge: Pick<PlexEdge, 'alternatives' | 'weights'>
): PlexPayload {
    if (edge.alternatives.length !== edge.weights.length) {
        throw new Error('Plex edge alternatives and weights must have the same length.');
    }
    if (edge.alternatives.length === 0) {
        throw new Error('Cannot append an empty plex edge.');
    }

    if (edge.alternatives.length === 1) {
        return createPlexPayload([...payload.combo.fixed, edge.alternatives[0]!], payload.combo.choices, payload.weights);
    }

    return createPlexPayload(
        payload.combo.fixed,
        [...payload.combo.choices, edge.alternatives],
        [...payload.weights, edge.weights]
    );
}

export function materializePlexPayloadFactors(
    payload: PlexPayload,
    enchantToIndex: Map<number, number>
): readonly PlexComboFactor[] {
    if (payload.combo.choices.length !== payload.weights.length) {
        throw new Error('Plex payload choices and weights must have the same length.');
    }

    const materialized: PlexComboFactor[] = [];
    const selected = [...payload.combo.fixed];

    function visit(choiceIndex: number, numerator: bigint, denominator: bigint): void {
        if (choiceIndex >= payload.combo.choices.length) {
            materialized.push(Object.freeze({
                combo: ComboUtils.pack(selected, enchantToIndex),
                numerator,
                denominator
            }));
            return;
        }

        const choice = payload.combo.choices[choiceIndex]!;
        const weights = payload.weights[choiceIndex]!;
        if (choice.length !== weights.length) {
            throw new Error('Plex payload choice alternatives and weights must have the same length.');
        }

        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
        if (totalWeight <= 0) {
            throw new Error('Plex payload choice weights must have positive total weight.');
        }

        for (let i = 0; i < choice.length; i++) {
            const weight = weights[i]!;
            if (weight <= 0) continue;
            selected.push(choice[i]!);
            visit(choiceIndex + 1, numerator * BigInt(weight), denominator * BigInt(totalWeight));
            selected.pop();
        }
    }

    visit(0, 1n, 1n);
    return Object.freeze(materialized);
}

function canonicalizeWeightedChoices(
    choices: readonly (readonly PackedEnchant[])[],
    weights: readonly (readonly number[])[]
): readonly WeightedChoice[] {
    if (weights.length !== 0 && weights.length !== choices.length) {
        throw new Error('Plex choice weights must be empty or match choice count.');
    }

    return Object.freeze(choices.map((choice, choiceIndex) => {
        const rawWeights = weights[choiceIndex] ?? choice.map(() => 1);
        if (choice.length !== rawWeights.length) {
            throw new Error('Plex choice alternatives and weights must have the same length.');
        }

        const weightsByAlternative = new Map<PackedEnchant, number>();
        for (let i = 0; i < choice.length; i++) {
            const alternative = choice[i]!;
            const weight = rawWeights[i]!;
            if (weight <= 0) throw new Error('Plex choice weights must be positive.');
            weightsByAlternative.set(alternative, (weightsByAlternative.get(alternative) ?? 0) + weight);
        }

        const alternatives = canonicalizePackedEnchantList([...weightsByAlternative.keys()]);
        return Object.freeze({
            alternatives,
            weights: Object.freeze(alternatives.map(alternative => weightsByAlternative.get(alternative)!))
        });
    }).sort((a, b) => comparePackedEnchantLists(a.alternatives, b.alternatives)));
}
