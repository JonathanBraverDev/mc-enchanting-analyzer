import type { PackedEnchant } from '#types/index.js';
import type { PlexEdge } from '#lib/search/plex/PlexGraph.js';
import type { PlexWeightedChoice } from '#lib/search/plex/PlexChoice.js';
import {
    appendPlexPayloadEdge,
    createPlexPayload,
    EMPTY_PLEX_PAYLOAD,
    getPlexPayloadKey,
    forEachBookFactor,
    forEachPlexPayloadFactor,
    materializeBookFactors,
    materializePlexPayloadFactors,
    type PlexComboFactor,
    type PlexComboFactorVisitor,
    type PlexPayload,
    type PlexPayloadKey
} from '#lib/search/plex/PlexPayload.js';

/**
 * Owns Plex payload expression operations behind a stable boundary.
 *
 * The current implementation delegates to the canonical helpers in PlexPayload,
 * but PlexRun/PlexWorkStore should depend on this store rather than directly on
 * payload interning/canonicalization details. That gives us one place to later
 * switch from rich payload objects to compact payload IDs/DAG nodes.
 */
export class PlexPayloadStore {
    public readonly empty: PlexPayload = EMPTY_PLEX_PAYLOAD;
    private readonly appendCache: Array<Array<PlexPayload | undefined> | undefined> = [];

    public create(
        fixed: readonly PackedEnchant[] = [],
        choices: readonly PlexWeightedChoice[] = []
    ): PlexPayload {
        return createPlexPayload(fixed, choices);
    }

    public appendEdge(payload: PlexPayload, edge: Pick<PlexEdge, 'choice'>): PlexPayload {
        const payloadId = Number(payload.id);
        const choiceId = Number(edge.choice.id);
        let payloadTransitions = this.appendCache[payloadId];
        const cached = payloadTransitions?.[choiceId];
        if (cached) return cached;

        const next = appendPlexPayloadEdge(payload, edge);
        if (!payloadTransitions) {
            payloadTransitions = [];
            this.appendCache[payloadId] = payloadTransitions;
        }
        payloadTransitions[choiceId] = next;
        return next;
    }

    public key(payload: PlexPayload): PlexPayloadKey {
        return getPlexPayloadKey(payload);
    }

    public materializeFactors(
        payload: PlexPayload,
        enchantToIndex: Map<number, number>
    ): readonly PlexComboFactor[] {
        return materializePlexPayloadFactors(payload, enchantToIndex);
    }

    public forEachFactor(
        payload: PlexPayload,
        enchantToIndex: Map<number, number>,
        visitor: PlexComboFactorVisitor
    ): void {
        forEachPlexPayloadFactor(payload, enchantToIndex, visitor);
    }

    public materializeBookFactors(
        payload: PlexPayload,
        enchantToIndex: Map<number, number>
    ): readonly PlexComboFactor[] {
        return materializeBookFactors(payload, enchantToIndex);
    }

    public forEachBookFactor(
        payload: PlexPayload,
        enchantToIndex: Map<number, number>,
        visitor: PlexComboFactorVisitor
    ): void {
        forEachBookFactor(payload, enchantToIndex, visitor);
    }
}
