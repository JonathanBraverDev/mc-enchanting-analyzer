import type { PackedEnchant } from '#types/index.js';

export type CanonicalPackedEnchantList = readonly PackedEnchant[];
export type CanonicalChoiceSet = readonly CanonicalPackedEnchantList[];
export type PlexChoiceId = number & { readonly __brand: 'PlexChoiceId' };

interface ChoiceInternNode {
    readonly next: Map<number, ChoiceInternNode>;
    choice?: PlexWeightedChoice | undefined;
}

let nextPlexChoiceId = 1;
const choiceInternRoot: ChoiceInternNode = { next: new Map<number, ChoiceInternNode>() };

export interface PlexAlternative {
    readonly packedEnchant: PackedEnchant;
    readonly weight: number;
}

export interface PlexWeightedChoice {
    /** Dense structural identity for hot payload intern maps. */
    readonly id: PlexChoiceId;
    readonly alternatives: readonly PlexAlternative[];
    readonly totalWeight: number;
    /** Cached canonical packed-enchant view for hot-path payload/key operations. */
    readonly packedEnchants?: CanonicalPackedEnchantList | undefined;
    /** Cached stable key including edge-local weights. */
    readonly key?: string | undefined;
}

/**
 * Returns a canonical copy of one exact edge-local choice list.
 *
 * The canonical order is ascending PackedEnchant value. Choice lists are expected
 * to be tiny, so the boring copy+sort path is preferred over cached keys until
 * profiling proves this is hot.
 */
export function canonicalizePackedEnchantList(
    alternatives: readonly PackedEnchant[]
): CanonicalPackedEnchantList {
    const sorted = [...alternatives].sort(comparePackedEnchant);
    assertNoDuplicatePackedEnchants(sorted);
    return Object.freeze(sorted);
}

/**
 * Returns a canonical, order-insensitive choose-set.
 *
 * Each inner choice list is canonicalized first. The outer list is then sorted
 * lexicographically by the inner list contents, so equivalent products compare
 * equal regardless of traversal order.
 */
export function canonicalizeChoiceSet(
    choices: readonly (readonly PackedEnchant[])[]
): CanonicalChoiceSet {
    const normalized = choices
        .map(choice => canonicalizePackedEnchantList(choice))
        .sort(comparePackedEnchantLists);
    return Object.freeze(normalized);
}

export function canonicalizeWeightedChoice(
    alternatives: readonly { readonly packedEnchant: PackedEnchant; readonly weight: number }[]
): PlexWeightedChoice {
    if (alternatives.length === 0) {
        throw new Error('Cannot create an empty plex weighted choice.');
    }

    const weightsByAlternative = new Map<PackedEnchant, number>();
    for (const alternative of alternatives) {
        if (!Number.isInteger(alternative.weight) || alternative.weight <= 0) {
            throw new Error('Plex choice weights must be positive integers.');
        }
        weightsByAlternative.set(
            alternative.packedEnchant,
            (weightsByAlternative.get(alternative.packedEnchant) ?? 0) + alternative.weight
        );
    }

    const packedEnchants = canonicalizePackedEnchantList([...weightsByAlternative.keys()]);
    const weightedAlternatives = packedEnchants.map(packedEnchant => Object.freeze({
        packedEnchant,
        weight: weightsByAlternative.get(packedEnchant)!
    }));
    return internPlexWeightedChoice(weightedAlternatives, packedEnchants);
}

function internPlexWeightedChoice(
    weightedAlternatives: readonly PlexAlternative[],
    packedEnchants: CanonicalPackedEnchantList
): PlexWeightedChoice {
    let node = choiceInternRoot;
    for (const alternative of weightedAlternatives) {
        node = getOrCreateChoiceInternNode(node, Number(alternative.packedEnchant));
        node = getOrCreateChoiceInternNode(node, alternative.weight);
    }

    if (node.choice) return node.choice;

    const choice = Object.freeze({
        id: nextPlexChoiceId++ as PlexChoiceId,
        alternatives: Object.freeze(weightedAlternatives),
        totalWeight: weightedAlternatives.reduce((sum, alternative) => sum + alternative.weight, 0),
        packedEnchants,
        key: weightedAlternatives
            .map(alternative => `${String(alternative.packedEnchant)}:${alternative.weight}`)
            .join(',')
    });
    node.choice = choice;
    return choice;
}

function getOrCreateChoiceInternNode(parent: ChoiceInternNode, key: number): ChoiceInternNode {
    let node = parent.next.get(key);
    if (!node) {
        node = { next: new Map<number, ChoiceInternNode>() };
        parent.next.set(key, node);
    }
    return node;
}

export function getPlexChoicePackedEnchants(choice: PlexWeightedChoice): CanonicalPackedEnchantList {
    if (choice.packedEnchants) return choice.packedEnchants;
    return Object.freeze(choice.alternatives.map(alternative => alternative.packedEnchant));
}

export function comparePlexWeightedChoices(a: PlexWeightedChoice, b: PlexWeightedChoice): number {
    return comparePackedEnchantLists(getPlexChoicePackedEnchants(a), getPlexChoicePackedEnchants(b));
}

export function comparePackedEnchant(a: PackedEnchant, b: PackedEnchant): number {
    return Number(a) - Number(b);
}

export function comparePackedEnchantLists(
    a: readonly PackedEnchant[],
    b: readonly PackedEnchant[]
): number {
    const sharedLength = Math.min(a.length, b.length);
    for (let i = 0; i < sharedLength; i++) {
        const left = a[i]!;
        const right = b[i]!;
        if (left !== right) return comparePackedEnchant(left, right);
    }
    return a.length - b.length;
}

export function samePackedEnchantList(
    a: readonly PackedEnchant[],
    b: readonly PackedEnchant[]
): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export function sameChoiceSet(
    a: CanonicalChoiceSet,
    b: CanonicalChoiceSet
): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (!samePackedEnchantList(a[i]!, b[i]!)) return false;
    }
    return true;
}

function assertNoDuplicatePackedEnchants(sorted: readonly PackedEnchant[]): void {
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i - 1] === sorted[i]) {
            throw new Error(`Duplicate PackedEnchant ${String(sorted[i])} in plex choice list.`);
        }
    }
}
