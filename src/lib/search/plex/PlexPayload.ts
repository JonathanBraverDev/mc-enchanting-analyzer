import type { PackedCombo, PackedEnchant } from '#types/index.js';
import { ComboUtils } from '#utils/index.js';
import {
    canonicalizePackedEnchantList,
    comparePackedEnchant,
    comparePlexWeightedChoices,
    getPlexChoicePackedEnchants,
    type CanonicalPackedEnchantList,
    type PlexWeightedChoice
} from '#lib/search/plex/PlexChoice.js';
import {
    EMPTY_PLEX_COMBO,
    type PlexCombo
} from '#lib/search/plex/PlexCombo.js';
import type { PlexEdge } from '#lib/search/plex/PlexGraph.js';

export type PlexPayloadKey = string;
export type PlexPayloadId = number & { readonly __brand: 'PlexPayloadId' };

interface PayloadInternNode {
    children?: Map<number, PayloadInternNode> | undefined;
    payload?: PlexPayload | undefined;
}

let nextPlexPayloadId = 1;
const payloadInternRoot: PayloadInternNode = {};
const plexPayloadKeyCache = new WeakMap<PlexPayload, PlexPayloadKey>();

/**
 * Weighted accumulated combo expression carried by the plex frontier/results.
 *
 * `combo` is the unweighted expression used for canonical ordering and concrete
 * combo materialization. `choices` carries the matching edge-local weights needed
 * to split/materialize aggregate choices. The arrays are intentionally separate
 * but aligned: `combo.choices[i]` is the packed-enchant view of `choices[i]`.
 */
export interface PlexPayload {
    /** Dense identity used by hot-path frontier/residue maps. */
    readonly id: PlexPayloadId;
    readonly combo: PlexCombo;
    readonly choices: readonly PlexWeightedChoice[];
}

export interface PlexComboFactor {
    readonly combo: PackedCombo;
    readonly numerator: bigint;
    readonly denominator: bigint;
}

export type PlexComboFactorVisitor = (combo: PackedCombo, numerator: bigint, denominator: bigint) => void;

export const EMPTY_PLEX_PAYLOAD: PlexPayload = Object.freeze({
    id: 0 as PlexPayloadId,
    combo: EMPTY_PLEX_COMBO,
    choices: Object.freeze([])
});
payloadInternRoot.payload = EMPTY_PLEX_PAYLOAD;
plexPayloadKeyCache.set(EMPTY_PLEX_PAYLOAD, 'f=|c=');

export function createPlexPayload(
    fixed: readonly PackedEnchant[] = [],
    choices: readonly PlexWeightedChoice[] = []
): PlexPayload {
    const canonicalFixed = canonicalizePackedEnchantList(fixed);
    const canonicalChoices = canonicalizeWeightedChoices(choices);
    return createCanonicalPlexPayload(canonicalFixed, canonicalChoices);
}

export function appendPlexPayloadEdge(
    payload: PlexPayload,
    edge: Pick<PlexEdge, 'choice'>
): PlexPayload {
    const alternatives = getPlexChoicePackedEnchants(edge.choice);

    if (alternatives.length === 1) {
        const fixed = insertPackedEnchant(payload.combo.fixed, alternatives[0]!);
        return createCanonicalPlexPayload(fixed, payload.choices);
    }

    const choices = insertWeightedChoice(payload.choices, edge.choice);
    return createCanonicalPlexPayload(payload.combo.fixed, choices);
}

export function getPlexPayloadKey(payload: PlexPayload): PlexPayloadKey {
    const cached = plexPayloadKeyCache.get(payload);
    if (cached !== undefined) return cached;
    const key = createPayloadKey(payload.combo.fixed, payload.choices);
    plexPayloadKeyCache.set(payload, key);
    return key;
}

function createCanonicalPlexPayload(
    fixed: CanonicalPackedEnchantList,
    choices: readonly PlexWeightedChoice[]
): PlexPayload {
    const internNode = getPlexPayloadInternNode(fixed, choices);
    if (internNode.payload) return internNode.payload;

    const comboChoices = Object.freeze(choices.map(getPlexChoicePackedEnchants));
    const combo: PlexCombo = Object.freeze({ fixed, choices: comboChoices });
    const payload = Object.freeze({
        id: nextPlexPayloadId++ as PlexPayloadId,
        combo,
        choices
    });
    internNode.payload = payload;
    return payload;
}

function getPlexPayloadInternNode(
    fixed: readonly PackedEnchant[],
    choices: readonly PlexWeightedChoice[]
): PayloadInternNode {
    let node = payloadInternRoot;
    for (const packedEnchant of fixed) {
        node = getOrCreatePayloadInternNode(node, createFixedPayloadInternKey(packedEnchant));
    }
    for (const choice of choices) {
        node = getOrCreatePayloadInternNode(node, createChoicePayloadInternKey(choice.id));
    }

    return node;
}

function getOrCreatePayloadInternNode(
    parent: PayloadInternNode,
    key: number
): PayloadInternNode {
    let children = parent.children;
    if (!children) {
        children = new Map<number, PayloadInternNode>();
        parent.children = children;
    }

    let node = children.get(key);
    if (!node) {
        node = {};
        children.set(key, node);
    }
    return node;
}

function createFixedPayloadInternKey(packedEnchant: PackedEnchant): number {
    return Number(packedEnchant) * 2;
}

function createChoicePayloadInternKey(choiceId: number): number {
    return (choiceId * 2) + 1;
}

function createPayloadKey(
    fixed: readonly PackedEnchant[],
    choices: readonly PlexWeightedChoice[]
): PlexPayloadKey {
    return `f=${createPackedEnchantListKey(fixed)}|c=${createChoiceKey(choices)}`;
}

function createPackedEnchantListKey(packedEnchants: readonly PackedEnchant[]): string {
    return packedEnchants.map(packedEnchant => String(packedEnchant)).join(',');
}

function createChoiceKey(choices: readonly PlexWeightedChoice[]): string {
    return choices
        .map(getPlexWeightedChoiceKey)
        .join('/');
}

function getPlexWeightedChoiceKey(choice: PlexWeightedChoice): string {
    if (choice.key !== undefined) return choice.key;
    return choice.alternatives
        .map(alternative => `${String(alternative.packedEnchant)}:${alternative.weight}`)
        .join(',');
}

function insertPackedEnchant(
    fixed: CanonicalPackedEnchantList,
    packedEnchant: PackedEnchant
): CanonicalPackedEnchantList {
    const next: PackedEnchant[] = [];
    let inserted = false;
    for (const current of fixed) {
        if (current === packedEnchant) {
            throw new Error(`Duplicate PackedEnchant ${String(packedEnchant)} in plex choice list.`);
        }
        if (!inserted && comparePackedEnchant(packedEnchant, current) < 0) {
            next.push(packedEnchant);
            inserted = true;
        }
        next.push(current);
    }
    if (!inserted) next.push(packedEnchant);
    return Object.freeze(next);
}

function insertWeightedChoice(
    choices: readonly PlexWeightedChoice[],
    choice: PlexWeightedChoice
): readonly PlexWeightedChoice[] {
    const next = choices.slice();
    let index = 0;
    while (index < next.length && comparePlexWeightedChoices(next[index]!, choice) <= 0) index++;
    next.splice(index, 0, choice);
    return Object.freeze(next);
}

export function materializePlexPayloadFactors(
    payload: PlexPayload,
    enchantToIndex: Map<number, number>
): readonly PlexComboFactor[] {
    assertAlignedPayload(payload);
    const materialized: PlexComboFactor[] = [];
    visitPlexPayloadFactors(payload, enchantToIndex, (combo, numerator, denominator) => {
        materialized.push(Object.freeze({ combo, numerator, denominator }));
    });
    return Object.freeze(materialized);
}

export function forEachPlexPayloadFactor(
    payload: PlexPayload,
    enchantToIndex: Map<number, number>,
    visitor: PlexComboFactorVisitor
): void {
    assertAlignedPayload(payload);
    visitPlexPayloadFactors(payload, enchantToIndex, visitor);
}

/**
 * Materializes the compatibility view for Minecraft's enchanted-book post-processing rule.
 *
 * If multiple enchantments were generated for a book, Minecraft removes one generated
 * enchantment uniformly at random. A plex choice group represents exactly one generated
 * enchantment slot, so removing that slot can happen before resolving its alternatives.
 */
export function materializeBookFactors(
    payload: PlexPayload,
    enchantToIndex: Map<number, number>
): readonly PlexComboFactor[] {
    assertAlignedPayload(payload);
    const materialized: PlexComboFactor[] = [];
    visitBookFactors(payload, enchantToIndex, (combo, numerator, denominator) => {
        materialized.push(Object.freeze({ combo, numerator, denominator }));
    });
    return Object.freeze(materialized);
}

export function forEachBookFactor(
    payload: PlexPayload,
    enchantToIndex: Map<number, number>,
    visitor: PlexComboFactorVisitor
): void {
    assertAlignedPayload(payload);
    visitBookFactors(payload, enchantToIndex, visitor);
}

function visitBookFactors(
    payload: PlexPayload,
    enchantToIndex: Map<number, number>,
    visitor: PlexComboFactorVisitor
): void {
    const slotCount = payload.combo.fixed.length + payload.choices.length;
    if (slotCount <= 1) {
        visitPlexPayloadFactors(payload, enchantToIndex, visitor);
        return;
    }

    const slotCountBigInt = BigInt(slotCount);
    for (let fixedIndex = 0; fixedIndex < payload.combo.fixed.length; fixedIndex++) {
        visitPlexPayloadFactors(
            payload,
            enchantToIndex,
            visitor,
            fixedIndex,
            undefined,
            slotCountBigInt
        );
    }

    for (let choiceIndex = 0; choiceIndex < payload.choices.length; choiceIndex++) {
        visitPlexPayloadFactors(
            payload,
            enchantToIndex,
            visitor,
            undefined,
            choiceIndex,
            slotCountBigInt
        );
    }
}

function visitPlexPayloadFactors(
    payload: PlexPayload,
    enchantToIndex: Map<number, number>,
    visitor: PlexComboFactorVisitor,
    removedFixedIndex?: number,
    removedChoiceIndex?: number,
    initialDenominator: bigint = 1n
): void {
    const selected = payload.combo.fixed.filter((_, index) => index !== removedFixedIndex);

    function visit(choiceIndex: number, numerator: bigint, denominator: bigint): void {
        if (choiceIndex >= payload.choices.length) {
            visitor(ComboUtils.pack(selected, enchantToIndex), numerator, denominator);
            return;
        }

        if (choiceIndex === removedChoiceIndex) {
            visit(choiceIndex + 1, numerator, denominator);
            return;
        }

        const choice = payload.choices[choiceIndex]!;
        const choiceTotalWeight = BigInt(choice.totalWeight);
        for (const alternative of choice.alternatives) {
            selected.push(alternative.packedEnchant);
            visit(
                choiceIndex + 1,
                numerator * BigInt(alternative.weight),
                denominator * choiceTotalWeight
            );
            selected.pop();
        }
    }

    visit(0, 1n, initialDenominator);
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
