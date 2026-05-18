import type { PackedCombo, PackedEnchant } from '#types/index.js';
import { ComboUtils } from '#utils/index.js';
import {
    canonicalizeChoiceSet,
    canonicalizePackedEnchantList,
    comparePackedEnchantLists,
    type CanonicalChoiceSet,
    type CanonicalPackedEnchantList
} from '#lib/search/plex/PlexChoice.js';
import type { PlexEdge } from '#lib/search/plex/PlexGraph.js';

export interface PlexCombo {
    readonly fixed: CanonicalPackedEnchantList;
    readonly choices: CanonicalChoiceSet;
}

export const EMPTY_PLEX_COMBO: PlexCombo = Object.freeze({
    fixed: Object.freeze([]),
    choices: Object.freeze([])
});

export function createPlexCombo(
    fixed: readonly PackedEnchant[] = [],
    choices: readonly (readonly PackedEnchant[])[] = []
): PlexCombo {
    return Object.freeze({
        fixed: canonicalizePackedEnchantList(fixed),
        choices: canonicalizeChoiceSet(choices)
    });
}

export function appendPlexEdge(combo: PlexCombo, edge: Pick<PlexEdge, 'alternatives'>): PlexCombo {
    if (edge.alternatives.length === 0) {
        throw new Error('Cannot append an empty plex edge.');
    }

    if (edge.alternatives.length === 1) {
        return createPlexCombo([...combo.fixed, edge.alternatives[0]!], combo.choices);
    }

    return createPlexCombo(combo.fixed, [...combo.choices, edge.alternatives]);
}

export function getPlexSlotCount(combo: PlexCombo): number {
    return combo.fixed.length + combo.choices.length;
}

export function isConcretePlexCombo(combo: PlexCombo): boolean {
    return combo.choices.length === 0;
}

export function materializePlexCombo(
    combo: PlexCombo,
    enchantToIndex: Map<number, number>
): readonly PackedCombo[] {
    if (combo.choices.length === 0) {
        return [ComboUtils.pack([...combo.fixed], enchantToIndex)];
    }

    const materialized: PackedCombo[] = [];
    const selected = [...combo.fixed];

    function visit(choiceIndex: number): void {
        if (choiceIndex >= combo.choices.length) {
            materialized.push(ComboUtils.pack(selected, enchantToIndex));
            return;
        }

        const choice = combo.choices[choiceIndex]!;
        for (const alternative of choice) {
            selected.push(alternative);
            visit(choiceIndex + 1);
            selected.pop();
        }
    }

    visit(0);
    return Object.freeze(materialized);
}

export function comparePlexCombo(a: PlexCombo, b: PlexCombo): number {
    const fixed = comparePackedEnchantLists(a.fixed, b.fixed);
    if (fixed !== 0) return fixed;

    const sharedLength = Math.min(a.choices.length, b.choices.length);
    for (let i = 0; i < sharedLength; i++) {
        const choice = comparePackedEnchantLists(a.choices[i]!, b.choices[i]!);
        if (choice !== 0) return choice;
    }
    return a.choices.length - b.choices.length;
}

export function samePlexCombo(a: PlexCombo, b: PlexCombo): boolean {
    return comparePlexCombo(a, b) === 0;
}
